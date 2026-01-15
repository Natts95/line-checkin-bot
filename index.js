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
    range: 'A:E',
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
   🧠 In-memory storage
====================== */

// 📌 พนักงานทั้งหมดที่เคยคุยกับบอท
const employeeList = {}; 
// { userId: { name } }

// 📌 check-in เฉพาะ “วันนี้”
const checkinStore = {}; 
// { userId: { date, workType } }

/* ======================
   Helper functions
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
   🔔 Auto Reminder
====================== */
async function sendReminder(label) {
  if (isSunday()) return;

  const today = getToday();
  const thaiDate = formatThaiDate();

  for (const userId in employeeList) {
    if (checkinStore[userId]?.date !== today) {
      await client.pushMessage(userId, {
        type: 'text',
        text: `${label}\n${thaiDate}\n${employeeList[userId].name} อย่าลืม check-in นะคะ`,
      }).catch(console.error);
    }
  }
}

cron.schedule('0 9 * * *', () => sendReminder('⏰ แจ้งเตือน 09:00'), {
  timezone: 'Asia/Bangkok',
});

cron.schedule('20 9 * * *', () => sendReminder('⚠️ แจ้งเตือนครั้งสุดท้าย 09:20\nระบบจะปิด 09:30'), {
  timezone: 'Asia/Bangkok',
});

/* ======================
   📊 Daily Summary 09:45
====================== */
cron.schedule('45 9 * * *', async () => {
  if (isSunday()) return;

  const today = getToday();
  const thaiDate = formatThaiDate();
  const adminIds = process.env.ADMIN_USER_IDS?.split(',') || [];

  let checked = [];
  let notChecked = [];

  for (const userId in employeeList) {
    const name = employeeList[userId].name;
    if (checkinStore[userId]?.date === today) {
      checked.push(`• ${name}`);
    } else {
      notChecked.push(`• ${name}`);
    }
  }

  const message =
`📊 สรุปการทำงานประจำวัน
${thaiDate}

✅ check-in แล้ว (${checked.length})
${checked.join('\n') || '-'}

❌ ยังไม่ check-in (${notChecked.length})
${notChecked.join('\n') || '-'}`;

  for (const adminId of adminIds) {
    await client.pushMessage(adminId, {
      type: 'text',
      text: message,
    }).catch(console.error);
  }
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

      // ✅ ลงทะเบียนพนักงานอัตโนมัติ
      employeeList[userId] = { name };

      if (text === 'whoami') {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `👤 ${name}\nuserId:\n${userId}`,
        });
        continue;
      }

      if (text === 'checkin') {
        if (isSunday())
          return client.replyMessage(event.replyToken,{type:'text',text:'❌ วันอาทิตย์ไม่ต้อง check-in ค่ะ'});
        if (isAfter0930())
          return client.replyMessage(event.replyToken,{type:'text',text:`⛔ ${name} ระบบปิดแล้ว (หลัง 09:30)`});
        if (checkinStore[userId]?.date === today)
          return client.replyMessage(event.replyToken,{type:'text',text:`⚠️ ${name} วันนี้คุณบันทึกไปแล้ว`});

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
        continue;
      }

      if (text.startsWith('work:')) {
        if (isAfter0930())
          return client.replyMessage(event.replyToken,{type:'text',text:`⛔ ${name} ระบบปิดแล้ว`});

        const map = {
          'work:full': 'ทำงานเต็มวัน',
          'work:half-morning': 'ครึ่งวันเช้า',
          'work:half-afternoon': 'ครึ่งวันบ่าย',
          'work:off': 'หยุดงาน',
        };

        checkinStore[userId] = { date: today, workType: text };

        await saveCheckinToSheet({
          date: today,
          userId,
          name,
          workType: map[text],
        });

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `✅ บันทึกเรียบร้อย\n${thaiDate}\n${name} (${map[text]})`,
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
   Server
====================== */
app.get('/', (_, res) => res.send('LINE Bot is running 🚀'));
app.get('/health', (_, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));