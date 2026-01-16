const express = require('express');
const line = require('@line/bot-sdk');
const { google } = require('googleapis');
const cron = require('node-cron');

/* ======================
   ENV
====================== */
const {
  CHANNEL_ACCESS_TOKEN,
  CHANNEL_SECRET,
  ADMIN_USER_ID,
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  SPREADSHEET_ID,
} = process.env;

/* ======================
   Google Sheets Auth
====================== */
const auth = new google.auth.JWT(
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  null,
  GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/spreadsheets']
);

async function sheets() {
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

/* ======================
   Utils
====================== */
function todayTH() {
  const d = new Date();
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

function isSundayTH() {
  return new Date().toLocaleDateString('en-US', { timeZone:'Asia/Bangkok', weekday:'short' }) === 'Sun';
}

function thaiDate() {
  const d = new Date();
  return d.toLocaleDateString('th-TH', {
    timeZone: 'Asia/Bangkok',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/* ======================
   Sheet helpers
====================== */
async function append(range, values) {
  const s = await sheets();
  await s.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  });
}

async function read(range) {
  const s = await sheets();
  const res = await s.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });
  return res.data.values || [];
}

/* ======================
   Employee
====================== */
async function getEmployees() {
  const rows = await read('employee!A2:D');
  return rows.map(r => ({
    userId: r[0],
    name: r[1],
    status: r[2],
  }));
}

async function ensureEmployee(userId, name) {
  const list = await getEmployees();
  if (!list.find(e => e.userId === userId)) {
    await append('employee!A:D', [
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
async function hasCheckedToday(userId) {
  const rows = await read('checkin!A2:B');
  return rows.some(r => r[0] === todayTH() && r[1] === userId);
}

async function saveCheckin(userId, name, type) {
  await append('checkin!A:E', [
    todayTH(),
    userId,
    name,
    type,
    new Date().toLocaleString('th-TH'),
  ]);
}

/* ======================
   LINE Setup
====================== */
const app = express();
const client = new line.Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET,
});

/* ======================
   Webhook
====================== */
app.post('/webhook', line.middleware({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET,
}), async (req, res) => {
  try {
    for (const event of req.body.events) {
      if (event.type !== 'message' || event.message.type !== 'text') continue;

      const userId = event.source.userId;
      const text = event.message.text.toLowerCase().trim();
      const profile = await client.getProfile(userId);
      const name = profile.displayName;

      if (text === 'checkin') {
        if (isSundayTH())
          return client.replyMessage(event.replyToken,{ type:'text', text:'❌ วันอาทิตย์ไม่ต้อง check-in' });

        if (await hasCheckedToday(userId))
          return client.replyMessage(event.replyToken,{ type:'text', text:'⚠️ วันนี้คุณ check-in แล้ว' });

        await ensureEmployee(userId, name);

        return client.replyMessage(event.replyToken,{
          type:'template',
          altText:'เลือกประเภทงาน',
          template:{
            type:'buttons',
            text:`${thaiDate()}\n${name}`,
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
        await saveCheckin(userId, name, text);
        return client.replyMessage(event.replyToken,{
          type:'text',
          text:`✅ บันทึกเรียบร้อย\n${name}`,
        });
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

/* ======================
   CRON
====================== */

// 🔔 09:20 reminder
cron.schedule('20 9 * * 1-6', async () => {
  const employees = await getEmployees();
  for (const e of employees) {
    if (e.status === 'active' && !(await hasCheckedToday(e.userId))) {
      await client.pushMessage(e.userId,{ type:'text', text:'⏰ อีก 10 นาทีระบบจะปิด check-in' });
    }
  }
}, { timezone:'Asia/Bangkok' });

// 📊 09:45 daily report
cron.schedule('45 9 * * 1-6', async () => {
  const rows = await read('checkin!A2:D');
  const todayRows = rows.filter(r => r[0] === todayTH());
  let msg = `📊 Daily Report\n${thaiDate()}\n\n`;
  todayRows.forEach(r => msg += `• ${r[2]} — ${r[3]}\n`);
  await client.pushMessage(ADMIN_USER_ID,{ type:'text', text: msg });
}, { timezone:'Asia/Bangkok' });

/* ======================
   Server
====================== */
app.get('/',(_,res)=>res.send('OK'));
app.listen(process.env.PORT || 3000);
