const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const bodyParser = require('body-parser');
const { google } = require('googleapis');

/* ======================
   Google Sheets
====================== */
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
        new Date().toLocaleString('th-TH'),
      ]],
    },
  });
}

/* ======================
   Express + LINE
====================== */
const app = express();

app.use(bodyParser.json()); // ✅ สำคัญมาก

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

/* ======================
   Memory Store
====================== */
const checkinStore = {};

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
  const days = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
  const months = [
    'มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
    'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม',
  ];
  return `วัน${days[d.getDay()]}ที่ ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear() + 543}`;
}

function hasNotCheckedInToday(userId, today) {
  return !checkinStore[userId] || checkinStore[userId].date !== today;
}

/* ======================
   🔔 Auto Reminder
====================== */
cron.schedule('0 9 * * *', async () => {
  if (isSunday()) return;

  const today = getToday();
  const thaiDate = formatThaiDate();

  for (const userId in checkinStore) {
    if (hasNotCheckedInToday(userId, today)) {
      try {
        const profile = await client.getProfile(userId);
        await client.pushMessage(userId, {
          type: 'text',
          text: `⏰ แจ้งเตือน 09:00\n${thaiDate}\n${profile.displayName} อย่าลืม check-in นะคะ`,
        });
      } catch (e) {
        console.error(e.message);
      }
    }
  }
}, { timezone: 'Asia/Bangkok' });

cron.schedule('20 9 * * *', async () => {
  if (isSunday()) return;

  const today = getToday();
  const thaiDate = formatThaiDate();

  for (const userId in checkinStore) {
    if (hasNotCheckedInToday(userId, today)) {
      try {
        const profile = await client.getProfile(userId);
        await client.pushMessage(userId, {
          type: 'text',
          text: `⚠️ แจ้งเตือนครั้งสุดท้าย (09:20)\n${thaiDate}\nระบบจะปิด check-in เวลา 09:30`,
        });
      } catch (e) {
        console.error(e.message);
      }
    }
  }
}, { timezone: 'Asia/Bangkok' });

/* ======================
   📊 Daily Summary
====================== */
cron.schedule('45 9 * * *', async () => {
  if (isSunday()) return;

  const today = getToday();
  const thaiDate = formatThaiDate();
  const adminId = process.env.ADMIN_USER_ID;
  if (!adminId) return;

  let checkedIn = [];
  let notCheckedIn = [];

  for (const userId in checkinStore) {
    const profile = await client.getProfile(userId);
    const name = profile.displayName;

    if (checkinStore[userId].date === today) {
      checkedIn.push(`• ${name}`);
    } else {
      notCheckedIn.push(`• ${name}`);
    }
  }

  const msg =
`📊 สรุปการทำงานประจำวัน
${thaiDate}

✅ check-in แล้ว (${checkedIn.length})
${checkedIn.join('\n') || '-'}

❌ ยังไม่ check-in (${notCheckedIn.length})
${notCheckedIn.join('\n') || '-'}`;

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
      const text = event.message.text.toLowerCase().trim();
      const today = getToday();
      const thaiDate = formatThaiDate();

      const profile = await client.getProfile(userId);
      const name = profile.displayName;

      if (text === 'whoami') {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `👤 ${name}\nuserId:\n${userId}`,
        });
        continue;
      }

      if (text === 'checkin') {
        if (isSunday())
          return client.replyMessage(event.replyToken,{ type:'text', text:'❌ วันอาทิตย์ไม่ต้อง check-in ค่ะ' });

        if (isAfter0930())
          return client.replyMessage(event.replyToken,{ type:'text', text:'⛔ ระบบปิด check-in แล้ว (หลัง 09:30)' });

        await client.replyMessage(event.replyToken, {
          type: 'template',
          altText: 'เลือกประเภทงาน',
          template: {
            type: 'buttons',
            text: `${thaiDate}\n${name} วันนี้คุณทำงานแบบไหนคะ`,
            actions: [
              { label: 'ทำงานเต็มวัน', type: 'message', text: 'work:full' },
              { label: 'ครึ่งวันเช้า', type: 'message', text: 'work:half-morning' },
              { label: 'ครึ่งวันบ่าย', type: 'message', text: 'work:half-afternoon' },
              { label: 'หยุดงาน', type: 'message', text: 'work:off' },
            ],
          },
        });
      }

      if (text.startsWith('work:')) {
        checkinStore[userId] = { date: today, workType: text };

        await saveCheckinToSheet({
          date: today,
          userId,
          name,
          workType: text,
        });

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `✅ บันทึกเรียบร้อย\n${thaiDate}\n${name}`,
        });
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('WEBHOOK ERROR:', e);
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
