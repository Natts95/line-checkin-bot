const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

/* ======================
   LINE config
====================== */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

/* ======================
   Memory เก็บ check-in
   รูปแบบ:
   {
     userId: {
       date: 'YYYY-MM-DD',
       workType: 'full' | 'half-morning' | 'half-afternoon'
     }
   }
====================== */
const checkinStore = {};

/* ======================
   Helper functions
====================== */

// ได้วันที่วันนี้แบบ YYYY-MM-DD
function getToday() {
  const now = new Date();
  return now.toISOString().split('T')[0];
}

// ตรวจว่าเป็นวันอาทิตย์ไหม
function isSunday() {
  const now = new Date();
  return now.getDay() === 0; // Sunday = 0
}

// ตรวจว่าหลัง 09:30 หรือยัง
function isAfter0930() {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();

  if (hours > 9) return true;
  if (hours === 9 && minutes >= 30) return true;
  return false;
}

// แปลงวันที่เป็นภาษาไทย
function formatThaiDate() {
  const now = new Date();
  const days = [
    'อาทิตย์', 'จันทร์', 'อังคาร',
    'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'
  ];
  const months = [
    'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน',
    'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม',
    'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
  ];

  const dayName = days[now.getDay()];
  const date = now.getDate();
  const month = months[now.getMonth()];
  const year = now.getFullYear() + 543;

  return `วัน${dayName}ที่ ${date} ${month} ${year}`;
}

/* ======================
   Root + Health
====================== */
app.get('/', (req, res) => {
  res.send('LINE Bot is running 🚀');
});

app.get('/health', (req, res) => {
  res.send('OK');
});

/* ======================
   LINE Webhook
====================== */
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;

    for (const event of events) {
      if (event.type !== 'message') continue;
      if (event.message.type !== 'text') continue;

      const userId = event.source.userId;
      const text = event.message.text.toLowerCase().trim();

      // ดึงชื่อ user
      const profile = await client.getProfile(userId);
      const name = profile.displayName;
      const today = getToday();
      const thaiDate = formatThaiDate();

      /* ====== พิมพ์ checkin ====== */
      if (text === 'checkin') {

        // วันอาทิตย์
        if (isSunday()) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `❌ วันนี้เป็นวันอาทิตย์ ไม่ต้อง check-in ค่ะ`,
          });
          continue;
        }

        // หลัง 09:30
        if (isAfter0930()) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `⛔ ${name} ระบบปิด check-in แล้ว (หลัง 09:30)\nกรุณาติดต่อเจ้าของงานค่ะ`,
          });
          continue;
        }

        // เช็คว่ากดไปแล้วหรือยัง
        if (
          checkinStore[userId] &&
          checkinStore[userId].date === today
        ) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `⚠️ ${name} คุณได้ check-in วันนี้ไปแล้ว\nไม่สามารถแก้ไขได้ค่ะ`,
          });
          continue;
        }

        // ส่งปุ่มเลือกประเภทงาน
        await client.replyMessage(event.replyToken, {
          type: 'template',
          altText: 'เลือกประเภทการทำงาน',
          template: {
            type: 'buttons',
            text: `${thaiDate}\n${name} วันนี้คุณทำงานแบบไหนคะ`,
            actions: [
              {
                type: 'message',
                label: 'ทำงานเต็มวัน',
                text: 'work:full',
              },
              {
                type: 'message',
                label: 'ครึ่งวันเช้า',
                text: 'work:half-morning',
              },
              {
                type: 'message',
                label: 'ครึ่งวันบ่าย',
                text: 'work:half-afternoon',
              },
            ],
          },
        });

        continue;
      }

      /* ====== รับคำตอบประเภทงาน ====== */
      if (text.startsWith('work:')) {
        // หลัง 09:30
        if (isAfter0930()) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `⛔ ${name} ระบบปิด check-in แล้ว (หลัง 09:30)`,
          });
          continue;
        }

        // กดซ้ำ
        if (
          checkinStore[userId] &&
          checkinStore[userId].date === today
        ) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `⚠️ ${name} วันนี้คุณบันทึกไปแล้ว ไม่สามารถแก้ไขได้ค่ะ`,
          });
          continue;
        }

        const workTypeMap = {
          'work:full': 'ทำงานเต็มวัน',
          'work:half-morning': 'ครึ่งวันเช้า',
          'work:half-afternoon': 'ครึ่งวันบ่าย',
        };

        const workTypeText = workTypeMap[text];

        // บันทึก
        checkinStore[userId] = {
          date: today,
          workType: text,
        };

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `✅ ทำการบันทึกการทำงาน\n${thaiDate}\n${name}\n(${workTypeText}) เรียบร้อยค่ะ`,
        });

        continue;
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

/* ======================
   Start server
====================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
