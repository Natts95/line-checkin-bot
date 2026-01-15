/* ======================
   Google Sheets
====================== */
const { google } = require('googleapis');

const auth = new google.auth.JWT(
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  null,
  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/spreadsheets']
);

const sheets = google.sheets({ version: 'v4', auth });

async function saveCheckinToSheet({ date, userId, name, workType }) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'checkin!A:E',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        date,
        userId,
        name,
        workType,
        new Date().toLocaleString('th-TH')
      ]],
    },
  });
}

async function hasCheckedInToday(userId) {
  const today = getToday();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'checkin!A2:B',
  });

  const rows = res.data.values || [];
  return rows.some(r => r[0] === today && r[1] === userId);
}

/* ======================
   👥 Employees (CACHE)
====================== */
let EMP_CACHE = {};
let LAST_LOAD = 0;

async function loadEmployees(force = false) {
  if (!force && Date.now() - LAST_LOAD < 60_000) return EMP_CACHE;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'employees!A2:D',
  });

  const rows = res.data.values || [];
  const map = {};

  for (const [userId, name, role, active] of rows) {
    if (active === 'TRUE') {
      map[userId] = { name, role };
    }
  }

  EMP_CACHE = map;
  LAST_LOAD = Date.now();
  return map;
}

/* ======================
   Express + LINE
====================== */
const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

/* ======================
   Helpers
====================== */
function getToday() {
  return new Date().toISOString().split('T')[0];
}

function isSunday() {
  return new Date().getDay() === 0;
}

function isAfter0930() {
  const now = new Date();
  return now.getHours() > 9 || (now.getHours() === 9 && now.getMinutes() >= 30);
}

function formatThaiDate() {
  const d = new Date();
  const days = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
  const months = [
    'มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
    'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'
  ];
  return `วัน${days[d.getDay()]}ที่ ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()+543}`;
}

/* ======================
   🔔 Reminder
====================== */
async function sendReminder(label) {
  if (isSunday()) return;

  let employees;
  try {
    employees = await loadEmployees();
  } catch (e) {
    console.error('LOAD EMP ERROR:', e);
    return;
  }

  const thaiDate = formatThaiDate();

  for (const userId in employees) {
    try {
      if (await hasCheckedInToday(userId)) continue;

      await client.pushMessage(userId, {
        type: 'text',
        text: `${label}\n${thaiDate}\n${employees[userId].name} อย่าลืม check-in นะคะ`,
      });
    } catch (e) {
      console.error('REMINDER ERROR:', e);
    }
  }
}

cron.schedule('0 9 * * *', () => sendReminder('⏰ แจ้งเตือน 09:00'), { timezone:'Asia/Bangkok' });
cron.schedule('20 9 * * *', () => sendReminder('⚠️ แจ้งเตือนครั้งสุดท้าย 09:20\nระบบจะปิด 09:30'), { timezone:'Asia/Bangkok' });

/* ======================
   📊 Daily Summary
====================== */
cron.schedule('45 9 * * *', async () => {
  if (isSunday()) return;

  let employees;
  try {
    employees = await loadEmployees();
  } catch (e) {
    console.error('SUMMARY LOAD EMP ERROR:', e);
    return;
  }

  const today = getToday();
  const thaiDate = formatThaiDate();

  let rows = [];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'checkin!A2:E',
    });
    rows = res.data.values || [];
  } catch (e) {
    console.error('SUMMARY SHEET ERROR:', e);
    return;
  }

  const checkedIds = new Set(rows.filter(r => r[0] === today).map(r => r[1]));

  let checked = [];
  let notChecked = [];

  for (const userId in employees) {
    const name = employees[userId].name;
    if (checkedIds.has(userId)) checked.push(`• ${name}`);
    else notChecked.push(`• ${name}`);
  }

  const message =
`📊 สรุปการทำงานประจำวัน
${thaiDate}

✅ check-in แล้ว (${checked.length})
${checked.join('\n') || '-'}

❌ ยังไม่ check-in (${notChecked.length})
${notChecked.join('\n') || '-'}`;

  for (const userId in employees) {
    if (employees[userId].role === 'admin') {
      await client.pushMessage(userId, { type:'text', text:message }).catch(console.error);
    }
  }
}, { timezone:'Asia/Bangkok' });

/* ======================
   LINE Webhook (LINE-SAFE)
====================== */
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    for (const event of req.body.events) {
      if (event.type !== 'message' || event.message.type !== 'text') continue;

      const userId = event.source.userId;
      const text = event.message.text.trim().toLowerCase();
      const thaiDate = formatThaiDate();

      /* ===== whoami ===== */
      if (text === 'whoami') {
        const profile = await client.getProfile(userId);
        await client.replyMessage(event.replyToken,{
          type:'text',
          text:`👤 ${profile.displayName}\nuserId:\n${userId}`
        });
        continue;
      }

      /* โหลด employee หลัง whoami */
      let employees;
      try {
        employees = await loadEmployees();
      } catch (e) {
        await client.replyMessage(event.replyToken,{
          type:'text',
          text:'⚠️ ระบบขัดข้อง กรุณาลองใหม่'
        });
        continue;
      }

      const employee = employees[userId];
      if (!employee) {
        await client.replyMessage(event.replyToken,{
          type:'text',
          text:'❌ คุณยังไม่ได้ถูกเพิ่มเป็นพนักงานในระบบ'
        });
        continue;
      }

      /* ===== checkin ===== */
      if (text === 'checkin') {
        if (isSunday()) {
          await client.replyMessage(event.replyToken,{ type:'text', text:'❌ วันอาทิตย์ไม่ต้อง check-in ค่ะ' });
          continue;
        }

        if (isAfter0930()) {
          await client.replyMessage(event.replyToken,{ type:'text', text:'⛔ ระบบปิดแล้ว (หลัง 09:30)' });
          continue;
        }

        await client.replyMessage(event.replyToken,{
          type:'template',
          altText:'เลือกประเภทงาน',
          template:{
            type:'buttons',
            text:`${thaiDate}\n${employee.name} วันนี้คุณทำงานแบบไหนคะ`,
            actions:[
              { label:'ทำงานเต็มวัน', type:'message', text:'work:full' },
              { label:'ครึ่งวันเช้า', type:'message', text:'work:half-morning' },
              { label:'ครึ่งวันบ่าย', type:'message', text:'work:half-afternoon' },
              { label:'หยุดงาน', type:'message', text:'work:off' },
            ]
          }
        });
        continue;
      }

      /* ===== work ===== */
      if (text.startsWith('work:')) {
        if (isAfter0930()) {
          await client.replyMessage(event.replyToken,{ type:'text', text:'⛔ ระบบปิดแล้ว' });
          continue;
        }

        const map = {
          'work:full':'ทำงานเต็มวัน',
          'work:half-morning':'ครึ่งวันเช้า',
          'work:half-afternoon':'ครึ่งวันบ่าย',
          'work:off':'หยุดงาน',
        };

        if (!map[text]) continue;

        try {
          if (await hasCheckedInToday(userId)) {
            await client.replyMessage(event.replyToken,{
              type:'text',
              text:'⚠️ วันนี้คุณ check-in ไปแล้ว'
            });
            continue;
          }

          await saveCheckinToSheet({
            date: getToday(),
            userId,
            name: employee.name,
            workType: map[text],
          });

          await client.replyMessage(event.replyToken,{
            type:'text',
            text:`✅ บันทึกเรียบร้อย\n${thaiDate}\n${employee.name} (${map[text]})`
          });

        } catch (e) {
          console.error('SAVE ERROR:', e);
          await client.replyMessage(event.replyToken,{
            type:'text',
            text:'⚠️ บันทึกไม่สำเร็จ กรุณาลองใหม่'
          });
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('WEBHOOK ERROR:', err);
    res.sendStatus(500);
  }
});

/* ======================
   Server
====================== */
app.get('/', (_, res) => res.send('LINE Bot is running 🚀'));
app.get('/health', (_, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
