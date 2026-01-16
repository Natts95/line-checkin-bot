const express = require('express');
const line = require('@line/bot-sdk');
const { google } = require('googleapis');
const cron = require('node-cron');

/* ======================
   Google Sheets
====================== */
const auth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

async function saveCheckinToSheet({ date, userId, name, workType }) {
  await auth.authorize();
  const sheets = google.sheets({ version: 'v4', auth });

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
        new Date().toLocaleString('th-TH'),
      ]],
    },
  });
}

/* ======================
   Express + LINE
====================== */
const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

/* ======================
   Memory (ชั่วคราว)
====================== */
const checkinStore = {};
const employees = {
  'U9f3cd3d1de967058e10642695e305241': { name: 'Nat', active: true },
};

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
  const d = new Date();
  return d.getHours() > 9 || (d.getHours() === 9 && d.getMinutes() >= 30);
}
function formatThaiDate() {
  const d = new Date();
  return `วันที่ ${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()+543}`;
}
function hasNotCheckedInToday(userId, today) {
  return !checkinStore[userId] || checkinStore[userId].date !== today;
}

/* ======================
   🔔 Cron Jobs
====================== */

/* 09:20 เตือนก่อนปิด */
cron.schedule('20 9 * * *', async () => {
  if (isSunday()) return;

  const today = getToday();
  const thaiDate = formatThaiDate();

  for (const userId in employees) {
    if (!employees[userId].active) continue;
    if (!hasNotCheckedInToday(userId, today)) continue;

    try {
      await client.pushMessage(userId, {
        type: 'text',
        text: `⚠️ แจ้งเตือน 09:20\n${thaiDate}\nอีก 10 นาทีระบบจะปิด check-in`,
      });
    } catch (err) {
      console.error('09:20 reminder error', err.message);
    }
  }
}, { timezone: 'Asia/Bangkok' });

/* 09:45 Report Admin */
cron.schedule('45 9 * * *', async () => {
  if (isSunday()) return;

  const adminId = process.env.ADMIN_USER_ID;
  const today = getToday();
  const thaiDate = formatThaiDate();

  let checked = [];
  let notChecked = [];

  for (const userId in employees) {
    if (!employees[userId].active) continue;

    if (checkinStore[userId]?.date === today) {
      checked.push(`• ${employees[userId].name}`);
    } else {
      notChecked.push(`• ${employees[userId].name}`);
    }
  }

  let msg = `📊 รายงานประจำวัน\n${thaiDate}\n\n`;
  msg += `✅ มา (${checked.length})\n${checked.join('\n') || '-'}`;
  msg += `\n\n❌ ไม่มา (${notChecked.length})\n${notChecked.join('\n') || '-'}`;

  await client.pushMessage(adminId, { type: 'text', text: msg });
}, { timezone: 'Asia/Bangkok' });

/* ======================
   Webhook
====================== */
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    for (const event of req.body.events) {
      if (event.type !== 'message' || event.message.type !== 'text') continue;

      const userId = event.source.userId;
      const text = event.message.text.trim().toLowerCase();
      const isAdmin = userId === process.env.ADMIN_USER_ID;

      const profile = await client.getProfile(userId);
      const name = profile.displayName;

      /* whoami */
      if (text === 'whoami') {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `👤 ${name}\n${isAdmin ? 'admin' : 'employee'}`,
        });
        continue;
      }

      /* checkin */
      if (text === 'checkin') {
        if (!isAdmin && !employees[userId]?.active)
          return client.replyMessage(event.replyToken,{ type:'text', text:'❌ คุณไม่ใช่ employee' });

        if (isSunday())
          return client.replyMessage(event.replyToken,{ type:'text', text:'❌ วันอาทิตย์ไม่ต้อง check-in' });

        if (isAfter0930() && !isAdmin)
          return client.replyMessage(event.replyToken,{ type:'text', text:'⛔ ระบบปิดแล้ว' });

        await client.replyMessage(event.replyToken, {
          type: 'template',
          altText: 'เลือกประเภทงาน',
          template: {
            type: 'buttons',
            text: `${formatThaiDate()}\n${name}`,
            actions: [
              { label: 'เต็มวัน', type: 'message', text: 'work:full' },
              { label: 'ครึ่งวันเช้า', type: 'message', text: 'work:half-morning' },
              { label: 'ครึ่งวันบ่าย', type: 'message', text: 'work:half-afternoon' },
              { label: 'หยุด', type: 'message', text: 'work:off' },
            ],
          },
        });
        continue;
      }

      /* work */
      if (text.startsWith('work:')) {
        checkinStore[userId] = { date: getToday(), workType: text };

        await saveCheckinToSheet({
          date: getToday(),
          userId,
          name,
          workType: text,
        });

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `✅ บันทึกสำเร็จ\n${name}`,
        });
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

/* ======================
   Health
====================== */
app.get('/', (_, res) => res.send('LINE Bot is running 🚀'));
app.get('/health', (_, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
