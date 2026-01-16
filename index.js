const express = require('express');
const line = require('@line/bot-sdk');
const { google } = require('googleapis');
const cron = require('node-cron');

/* ======================
   Google Auth
====================== */
const auth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

async function getSheets() {
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

/* ======================
   Helpers
====================== */
function today() {
  return new Date().toISOString().split('T')[0];
}
function isSunday(d = new Date()) {
  return d.getDay() === 0;
}
function isSaturday(d = new Date()) {
  return d.getDay() === 6;
}
function formatThaiDate(d = new Date()) {
  return `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()+543}`;
}

/* ======================
   Sheet Operations
====================== */
async function appendRow(sheet, range, values) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  });
}

async function readSheet(range) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range,
  });
  return res.data.values || [];
}

/* ======================
   Employee
====================== */
async function getEmployees() {
  const rows = await readSheet('employee!A2:D');
  return rows.map(r => ({
    userId: r[0],
    name: r[1],
    status: r[2],
  }));
}

async function ensureEmployee(userId, name) {
  const employees = await getEmployees();
  if (!employees.find(e => e.userId === userId)) {
    await appendRow('employee!A:D', [
      userId,
      name,
      'active',
      new Date().toISOString(),
    ]);
  }
}

/* ======================
   Check-in
====================== */
async function saveCheckin({ userId, name, workType }) {
  await appendRow('checkin!A:E', [
    today(),
    userId,
    name,
    workType,
    new Date().toLocaleString('th-TH'),
  ]);
}

/* ======================
   LINE Setup
====================== */
const app = express();
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

/* ======================
   Webhook
====================== */
app.post('/webhook', line.middleware(config), async (req, res) => {
  for (const event of req.body.events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const userId = event.source.userId;
    const text = event.message.text.toLowerCase().trim();
    const isAdmin = userId === process.env.ADMIN_USER_ID;
    const profile = await client.getProfile(userId);
    const name = profile.displayName;

    if (text === 'checkin') {
      await ensureEmployee(userId, name);
      if (isSunday()) {
        await client.replyMessage(event.replyToken,{ type:'text', text:'❌ วันอาทิตย์ไม่ต้อง check-in' });
        continue;
      }

      await client.replyMessage(event.replyToken,{
        type:'template',
        altText:'เลือกประเภทงาน',
        template:{
          type:'buttons',
          text:`${formatThaiDate()}\n${name}`,
          actions:[
            { label:'เต็มวัน', type:'message', text:'work:full' },
            { label:'ครึ่งวันเช้า', type:'message', text:'work:half-morning' },
            { label:'ครึ่งวันบ่าย', type:'message', text:'work:half-afternoon' },
            { label:'หยุด', type:'message', text:'work:off' },
          ],
        },
      });
    }

    if (text.startsWith('work:')) {
      await saveCheckin({ userId, name, workType: text });
      await client.replyMessage(event.replyToken,{
        type:'text',
        text:`✅ บันทึกสำเร็จ\n${name}`,
      });
    }

    if (text.startsWith('add ') && isAdmin) {
      const targetId = text.replace('add ','');
      await appendRow('employee!A:D',[targetId,'','active',new Date().toISOString()]);
      await client.replyMessage(event.replyToken,{ type:'text', text:'✅ เพิ่ม employee แล้ว' });
    }
  }
  res.sendStatus(200);
});

/* ======================
   ⏰ CRON JOBS
====================== */

/* 09:20 Reminder */
cron.schedule('20 9 * * 1-6', async () => {
  const employees = await getEmployees();
  const checkins = await readSheet('checkin!A2:B');
  const todayChecked = checkins.filter(r => r[0] === today()).map(r => r[1]);

  for (const e of employees) {
    if (e.status === 'active' && !todayChecked.includes(e.userId)) {
      await client.pushMessage(e.userId,{
        type:'text',
        text:'⏰ อีก 10 นาทีระบบ check-in จะปิด',
      });
    }
  }
});

/* 09:45 Daily Report */
cron.schedule('45 9 * * 1-6', async () => {
  const checkins = await readSheet('checkin!A2:D');
  const todayData = checkins.filter(r => r[0] === today());
  let msg = '📋 Daily Report\n';

  todayData.forEach(r => {
    msg += `• ${r[2]} — ${r[3]}\n`;
  });

  await client.pushMessage(process.env.ADMIN_USER_ID,{ type:'text', text: msg });
});

/* Saturday 10:00 Weekly Summary */
cron.schedule('0 10 * * 6', async () => {
  const rows = await readSheet('checkin!A2:D');
  const map = {};

  rows.forEach(r => {
    if (isSunday(new Date(r[0]))) return;
    const v = r[3].includes('full') ? 1 : r[3].includes('half') ? 0.5 : 0;
    map[r[2]] = (map[r[2]] || 0) + v;
  });

  let msg = '📊 Weekly Summary\n';
  Object.entries(map).forEach(([name, days]) => {
    msg += `• ${name}: ${days} วัน\n`;
  });

  await client.pushMessage(process.env.ADMIN_USER_ID,{ type:'text', text: msg });
});

/* ======================
   Health
====================== */
app.get('/',(_,res)=>res.send('LINE Bot running 🚀'));
app.listen(process.env.PORT||3000);
