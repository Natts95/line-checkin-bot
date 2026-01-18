const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const { google } = require('googleapis');

/* ======================
   Config & Auth
====================== */
const auth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const app = express();
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

/* ======================
   Memory Store
====================== */
let checkinStore = {}; 
let weeklyTransactions = {
    advance: {}, 
    repayment: {} 
};
const employees = {}; 
const admins = {};

/* ======================
   Google Sheets Functions
====================== */
async function saveToSheet(range, values) {
  try {
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [values] },
    });
  } catch (err) { console.error(`❌ Save Error (${range}):`, err.message); }
}

// ฟังก์ชัน: ค้นหา UserID (ตัวล่าสุด) แล้วอัปเดตหนี้
async function updateDebtInSheet(targetUserId, newDebtAmount) {
  try {
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });

    // 1. อ่านข้อมูล ID ทั้งหมด
    const readRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'employee!B:B', 
    });

    const rows = readRes.data.values;
    if (!rows || rows.length === 0) return;

    // 2. วนลูปหาบรรทัด (🌟 แก้ไข: หาจากล่างขึ้นบน เพื่อเอาตัวล่าสุดเสมอ)
    let targetRow = -1;
    for (let i = rows.length - 1; i >= 0; i--) { // เริ่มจากตัวสุดท้าย ถอยหลังมาตัวแรก
      if (rows[i][0] === targetUserId) {
        targetRow = i + 1; // เจอแล้ว! นี่คือบรรทัดล่าสุดของคนนี้
        break; // หยุดค้นหาทันที
      }
    }

    if (targetRow === -1) {
      console.log(`❌ ไม่พบ UserID: ${targetUserId} เพื่ออัปเดตหนี้`);
      return;
    }

    // 3. สั่งอัปเดตเฉพาะช่อง G (TotalDebt) ในบรรทัดที่เจอ
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `employee!G${targetRow}`, 
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[newDebtAmount]], 
      },
    });

    console.log(`✅ อัปเดตหนี้ (Latest Row): แถว ${targetRow}, ยอด ${newDebtAmount}`);

  } catch (err) {
    console.error('❌ UPDATE DEBT ERROR:', err.message);
  }
}

// ฟังก์ชัน: อัปเดตค่าแรง (DailyRate) ใน Google Sheet (Column F)
async function updateRateInSheet(targetUserId, newRate) {
  try {
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });

    // 1. อ่านข้อมูล ID ทั้งหมด
    const readRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'employee!B:B', 
    });

    const rows = readRes.data.values;
    if (!rows || rows.length === 0) return;

    // 2. วนลูปหาบรรทัด (หาจากล่างขึ้นบน เพื่อเอาตัวล่าสุด)
    let targetRow = -1;
    for (let i = rows.length - 1; i >= 0; i--) { 
      if (rows[i][0] === targetUserId) {
        targetRow = i + 1; 
        break; 
      }
    }

    if (targetRow === -1) {
      console.log(`❌ ไม่พบ UserID: ${targetUserId} เพื่ออัปเดตค่าแรง`);
      return;
    }

    // 3. สั่งอัปเดตช่อง F (DailyRate)
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `employee!F${targetRow}`, 
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[newRate]], 
      },
    });

    console.log(`✅ อัปเดตค่าแรง: แถว ${targetRow}, ยอด ${newRate}`);

  } catch (err) {
    console.error('❌ UPDATE RATE ERROR:', err.message);
  }
}

async function loadDataFromSheet() {
  console.log('🔄 Loading data...');
  try {
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });

    // Load Employees
    const empRes = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: 'employee!A:G' });
    if (empRes.data.values) {
        empRes.data.values.forEach(row => {
            const [, uid, name, status, , rate, debt] = row;
            if(!uid || uid === 'UserId') return;
            if(status === 'active') {
                employees[uid] = { name, active: true, dailyRate: parseInt(rate)||0, totalDebt: parseInt(debt)||0 };
            } else if(status === 'inactive' && employees[uid]) {
                employees[uid].active = false;
            }
        });
    }

    // Load Admins
    const admRes = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: 'admin!A:E' });
    if (admRes.data.values) {
        admRes.data.values.forEach(row => {
            const [, uid, name, status] = row;
            if(!uid) return;
            if(status === 'active') admins[uid] = { name, active: true };
            else if(status === 'inactive' && admins[uid]) admins[uid].active = false;
        });
    }

    // Load Checkins Today
    const today = getToday();
    const checkinRes = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: 'checkin!A:E' });
    if (checkinRes.data.values) {
        checkinRes.data.values.forEach(row => {
            if(row[0] === today) {
                if(!checkinStore[row[1]]) checkinStore[row[1]] = [];
                const exists = checkinStore[row[1]].find(r => r.date === today);
                if(!exists) checkinStore[row[1]].push({ date: row[0], workType: row[3] });
            }
        });
    }
    console.log(`✅ Loaded: ${Object.keys(employees).length} Employees`);
  } catch(e) { console.error(e); }
}

/* ======================
   Helpers & Time Logic (Fixed Timezone 🇹🇭)
====================== */

// ฟังก์ชัน: ดึงวันที่ปัจจุบัน (ยึดเวลาไทยเสมอ) -> Output: "2026-01-17"
function getToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

// ฟังก์ชัน: เช็คว่าเป็นวันอาทิตย์หรือไม่ (ยึดเวลาไทย)
function isSunday() {
  const dayOfWeek = new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok', weekday: 'short' });
  return dayOfWeek === 'Sun';
}

// ฟังก์ชัน: เช็คว่าหลัง 09:30 หรือไม่ (ยึดเวลาไทย)
function isAfter0930() {
  const now = new Date();
  const thaiTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  const hour = thaiTime.getHours();
  const minute = thaiTime.getMinutes();

  return hour > 9 || (hour === 9 && minute >= 30);
}

// ฟังก์ชัน: เช็คช่วงเวลาทำธุรกรรม 10:00 - 13:00 (ยึดเวลาไทย)
function isTransactionTime() {
  const now = new Date();
  const thaiTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  const hour = thaiTime.getHours();
  
  // 10:00 - 12:59
  return hour >= 10 && hour < 13;
}

// ⭐⭐ แก้ไข: เพิ่มวันในสัปดาห์ ⭐⭐
function formatThaiDate() {
    const days = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
    const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
    const now = new Date();
    const thaiTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    
    // Output: วันเสาร์ 17 ม.ค. 2569
    return `วัน${days[thaiTime.getDay()]} ${thaiTime.getDate()} ${months[thaiTime.getMonth()]} ${thaiTime.getFullYear()+543}`;
}

/* ======================
   ⏰ CRON JOBS
====================== */

// 1. 09:20 -> เตือน Check-in (จันทร์-เสาร์)
cron.schedule('20 9 * * 1-6', async () => { 
  const today = getToday();
  for (const uid in employees) {
    if (employees[uid].active) {
      const hasCheckedIn = checkinStore[uid]?.find(r => r.date === today);
      if (!hasCheckedIn) {
        try { 
            await client.pushMessage(uid, { 
                type: 'text', 
                text: `⚠️ คุณ ${employees[uid].name}\nอีก 10 นาทีระบบจะปิด Check-in แล้วนะคะ` 
            }); 
        } catch (e) {}
      }
    }
  }
}, { timezone: "Asia/Bangkok" });

// 2. 09:45 -> รายงาน Admin
cron.schedule('45 9 * * 1-6', async () => {
    const today = getToday();
    let report = `📊 สรุปการลงเวลา\n${formatThaiDate()}\n------------------\n`;
    let notCheckedIn = [];
    let checkedIn = [];

    for (const uid in employees) {
        if (employees[uid].active) {
            const record = checkinStore[uid]?.find(r => r.date === today);
            if (record) {
                let type = '✅ มาทำงาน';
                if (record.workType.includes('half')) type = '⛅ ครึ่งวัน';
                else if (record.workType.includes('off')) type = '🏠 หยุด';
                checkedIn.push(`${employees[uid].name} : ${type}`);
            } else {
                notCheckedIn.push(`❌ ${employees[uid].name}`);
            }
        }
    }
    if (checkedIn.length > 0) report += checkedIn.join('\n') + '\n';
    if (notCheckedIn.length > 0) report += `\n[ยังไม่เช็คอิน]\n` + notCheckedIn.join('\n');
    else report += `\n(ครบทุกคน)`;

    await client.pushMessage(process.env.ADMIN_USER_ID, { type: 'text', text: report }).catch(()=>{});
}, { timezone: "Asia/Bangkok" });

// 3. พุธ 10:00 -> เปิดให้เบิกเงิน
cron.schedule('0 10 * * 3', async () => { 
    for (const uid in employees) {
        if (!employees[uid].active) continue;
        await client.pushMessage(uid, {
            type: 'template',
            altText: 'ต้องการเบิกเงินวันนี้ไหมคะ?',
            template: {
                type: 'confirm',
                text: `💸 คุณ ${employees[uid].name}\nวันพุธแล้ว ต้องการ "เบิกเงินล่วงหน้า" ไหมคะ?\n(หมดเวลา 13:00 น.)`,
                actions: [
                    { label: 'ต้องการ', type: 'postback', data: 'req_advance:yes' },
                    { label: 'ไม่ต้องการ', type: 'message', text: 'ไม่เบิกค่ะ' }
                ]
            }
        }).catch(()=>{});
    }
}, { timezone: "Asia/Bangkok" });

// 4. พุธ 13:30 -> สรุปยอดเบิก
cron.schedule('30 13 * * 3', async () => {
    let msg = `💸 สรุปยอดเบิกวันพุธ\n----------------\n`;
    let total = 0;
    for(const uid in weeklyTransactions.advance) {
        msg += `${employees[uid]?.name || uid}: ${weeklyTransactions.advance[uid]} บาท\n`;
        total += weeklyTransactions.advance[uid];
    }
    msg += `----------------\nรวม: ${total} บาท`;
    await client.pushMessage(process.env.ADMIN_USER_ID, { type: 'text', text: msg });
}, { timezone: "Asia/Bangkok" });

// 5. ศุกร์ 10:00 -> เปิดให้จ่ายหนี้
cron.schedule('0 10 * * 5', async () => { 
    for (const uid in employees) {
        if (!employees[uid].active) continue;
        const currentDebt = employees[uid].totalDebt || 0;
        if (currentDebt <= 0) continue;

        await client.pushMessage(uid, {
            type: 'template',
            altText: 'ต้องการหักหนี้สัปดาห์นี้ไหมคะ?',
            template: {
                type: 'confirm',
                text: `คุณ ${employees[uid].name}\nวันศุกร์แล้ว หักหนี้ไหมคะ?\n(หนี้คงเหลือ: ${currentDebt} บาท)\n(หมดเวลา 13:00 น.)`,
                actions: [
                    { label: 'หักหนี้', type: 'postback', data: 'req_repayment:yes' },
                    { label: 'ไม่หัก', type: 'message', text: 'ไม่หักหนี้ค่ะ' }
                ]
            }
        }).catch(()=>{});
    }
}, { timezone: "Asia/Bangkok" });

// 6. ศุกร์ 13:30 -> สรุปยอดหักหนี้
cron.schedule('30 13 * * 5', async () => {
    let msg = `📉 สรุปยอดหักหนี้วันศุกร์\n----------------\n`;
    let total = 0;
    for(const uid in weeklyTransactions.repayment) {
        msg += `${employees[uid]?.name || uid}: ${weeklyTransactions.repayment[uid]} บาท\n`;
        total += weeklyTransactions.repayment[uid];
    }
    msg += `----------------\nรวม: ${total} บาท`;
    await client.pushMessage(process.env.ADMIN_USER_ID, { type: 'text', text: msg });
}, { timezone: "Asia/Bangkok" });

// 7. เสาร์ 10:00 -> Payroll Report
cron.schedule('0 10 * * 6', async () => { 
    let adminReport = `💰 สรุปค่าแรงประจำสัปดาห์\n${formatThaiDate()}\n=====================\n`;
    
    for (const uid in employees) {
        if (!employees[uid].active) continue;
        const emp = employees[uid];
        const userCheckins = checkinStore[uid] || [];
        let fullDays = 0, halfDays = 0, workDaysCount = 0;

        userCheckins.forEach(c => {
            if(c.workType.includes('full')) { fullDays++; workDaysCount++; }
            else if(c.workType.includes('half')) { halfDays++; workDaysCount += 0.5; }
        });

        const grossPay = workDaysCount * emp.dailyRate;
        const advance = weeklyTransactions.advance[uid] || 0;
        const debtPaid = weeklyTransactions.repayment[uid] || 0;
        const netPay = grossPay - advance - debtPaid;
        const remainingDebt = emp.totalDebt;

        // สลิปพนักงาน
        const slip = `🧾 สรุปยอดเงิน (Weekly)\n👤 ชื่อ: ${emp.name}\nประจำวันที่: ${formatThaiDate()}\n` +
                     `-----------------------\n` +
                     `วันทำงาน: ${fullDays} วันเต็ม, ${halfDays} ครึ่งวัน\n` +
                     `เงินรายสัปดาห์: ${grossPay.toLocaleString()} บาท\n` +
                     `หักเบิกวันพุธ: -${advance.toLocaleString()} บาท\n` +
                     `หักชำระหนี้: -${debtPaid.toLocaleString()} บาท\n` +
                     `-----------------------\n` +
                     `💰 เงินรับสุทธิ: ${netPay.toLocaleString()} บาท\n` +
                     `(หนี้คงเหลือ: ${remainingDebt.toLocaleString()} บาท)`;
        
        await client.pushMessage(uid, { type: 'text', text: slip }).catch(()=>{});

        // รายงาน Admin
        adminReport += `👤 ${emp.name}\n   ทำงาน: ${workDaysCount}วัน, จ่ายสุทธิ: ${netPay} บาท\n`;
    }

    await client.pushMessage(process.env.ADMIN_USER_ID, { type: 'text', text: adminReport }).catch(()=>{});
    
    weeklyTransactions = { advance: {}, repayment: {} }; // ล้างยอดธุรกรรม
    checkinStore = {}; // ล้างยอดวันทำงาน (ให้เริ่มนับ 0 ใหม่สำหรับวีคหน้า)

}, { timezone: "Asia/Bangkok" });


/* ======================
   Webhook
====================== */
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    for (const event of req.body.events) {
      const userId = event.source.userId;
      const isSuperAdmin = userId === process.env.ADMIN_USER_ID;
      const isAdmin = isSuperAdmin || admins[userId]?.active;
      
      const profile = await client.getProfile(userId);
      const name = employees[userId]?.name || profile.displayName; // ใช้ชื่อในระบบก่อน ถ้าไม่มีใช้ชื่อไลน์
      const thaiDate = formatThaiDate();

      // Handle Postback
      if (event.type === 'postback') {
          const data = event.postback.data;
          
          if (data === 'req_advance:yes') {
             if (!isTransactionTime()) {
                 await client.replyMessage(event.replyToken, { type: 'text', text: `❌ คุณ ${name} คะ\nหมดเวลาทำรายการแล้วค่ะ (วันพุธ 10:00-13:00)` });
                 continue;
             }
             await client.replyMessage(event.replyToken, { type: 'text', text: `กรุณาพิมพ์คำว่า "เบิก" เว้นวรรคและตามด้วยตัวเลข\nเช่น เบิก 500` });
          }

          if (data === 'req_repayment:yes') {
             if (!isTransactionTime()) {
                 await client.replyMessage(event.replyToken, { type: 'text', text: `❌ คุณ ${name} คะ\nหมดเวลาทำรายการแล้วค่ะ (วันศุกร์ 10:00-13:00)` });
                 continue;
             }
             await client.replyMessage(event.replyToken, { type: 'text', text: `กรุณาพิมพ์คำว่า "หัก" เว้นวรรคและตามด้วยตัวเลข\nเช่น หัก 500` });
          }
          continue;
      }

      // 🌟 [ส่วนที่ 1] จับเหตุการณ์เพิ่มเพื่อน (Follow)
      if (event.type === 'follow') {
        // แจ้งเตือน Admin ทันที (ใช้ profile ที่ประกาศไว้บรรทัดบนได้เลย)
        if (process.env.ADMIN_USER_ID) {
            await client.pushMessage(process.env.ADMIN_USER_ID, {
                type: 'text',
                text: `🆕 มีคนเพิ่มเพื่อนใหม่ค่ะ!\n👤 ชื่อ: ${profile.displayName}\n🆔 UserID:\n${userId}\n\n(Admin สามารถ Copy ID นี้ไปใช้คำสั่ง add employee ได้เลยค่ะ)`
            });
        }
        continue; 
      }

      if (event.type !== 'message' || event.message.type !== 'text') continue;
      const text = event.message.text.trim();
      const lower = text.toLowerCase();
      const today = getToday();

      // 🌟 [ส่วนที่ 2] ถ้าคนแปลกหน้าทักมา -> แจ้ง Admin
      // วางไว้หลังจากประกาศตัวแปร isAdmin เรียบร้อยแล้ว
      
      // ถ้าไม่ใช่ Admin และ ไม่อยู่ในรายชื่อพนักงาน (Active)
      if (!isAdmin && !employees[userId]?.active) {
          
          // 1. ตอบกลับผู้ใช้ (ให้เขารู้ตัวว่ายังใช้งานไม่ได้)
          await client.replyMessage(event.replyToken, {
              type: 'text',
              text: `สวัสดีค่ะ คุณ ${name}\nคุณยังไม่ได้ลงทะเบียนในระบบค่ะ\n\n(ระบบได้ส่ง ID ของคุณให้ Admin เรียบร้อยแล้วค่ะ กรุณารอ Admin ดำเนินการสักครู่นะคะ)`
          });

          // 2. แจ้ง Admin ให้ทราบ
          if (process.env.ADMIN_USER_ID) {
             await client.pushMessage(process.env.ADMIN_USER_ID, {
                type: 'text',
                text: `⚠️ มีคนแปลกหน้าทักแชทมาค่ะ\n👤 ชื่อ: ${name}\n💬 ข้อความ: "${text}"\n🆔 UserID:\n${userId}\n\n(Copy ID เพื่อ add employee ได้เลยค่ะ)`
             });
          }
          continue; // หยุดการทำงาน ไม่ต้องไปเช็คคำสั่งอื่นต่อ
      }

      /* ===== 0. Utility Commands (ปรับปรุงใหม่) ===== */
      
      // 1. whoami: บอกข้อมูลตัวตน / ID (Admin เห็น)
      if (lower === 'whoami') {
        let role = 'Guest';
        let showId = false;

        if (isSuperAdmin) {
            role = '👑 Super Admin';
            showId = true;
        } else if (isAdmin) {
            role = '🛡️ Admin';
            showId = true;
        } else if (employees[userId]?.active) {
            role = '💼 Employee';
        }
        
        let msg = `👤 ข้อมูลผู้ใช้\nชื่อ: ${name}\nสถานะ: ${role}`;
        if (showId) {
            msg += `\n🆔 ID: ${userId}`;
        }
        
        await client.replyMessage(event.replyToken, { type: 'text', text: msg });
        continue;
      }

      // 2. เช็คยอด: บอกวันทำงานในสัปดาห์นี้ / หนี้คงเหลือ
      if (lower === 'เช็คยอด' || lower === 'ยอดหนี้' || lower === 'เช็คสถานะ') {
        // ถ้าไม่ใช่พนักงาน ไม่ต้องตอบ
        if (!employees[userId]?.active && !isAdmin) continue; 

        const emp = employees[userId];
        
        // คำนวณวันทำงานของสัปดาห์นี้
        const userCheckins = checkinStore[userId] || [];
        let workDaysCount = 0;
        userCheckins.forEach(c => {
            if(c.workType.includes('full')) workDaysCount++;
            else if(c.workType.includes('half')) workDaysCount += 0.5;
        });

        const debt = emp ? emp.totalDebt.toLocaleString() : '0';

        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `📊 สรุปสถานะรายสัปดาห์\n👤 ชื่อ: ${name}\n✅ มาทำงานแล้ว: ${workDaysCount} วัน\n📉 หนี้คงเหลือ: ${debt} บาท`
        });
        continue;
      }

      // 3. วิธีใช้งาน: แสดงคู่มือ
      if (text === 'วิธีใช้งาน' || text === 'คู่มือ') {
          const manual = `💼 สำหรับ Employee (พนักงาน)\n\n` +
                         `📍 ลงเวลาทำงาน (Check-in)\n` +
                         `กดปุ่ม "check in" หรือพิมพ์ checkin\n` +
                         `ต้องทำภายในช่วง 00:00 - 09:30 น. เท่านั้น\n` +
                         `ถ้าเกินเวลา: ต้องแจ้ง Admin ให้ลงให้เท่านั้น\n\n` +
                         `📍 ธุรกรรมการเงิน (Weekly)\n\n` +
                         `วันพุธ (10:00 - 13:00 น.) -> ขอเบิกเงิน\n` +
                         `พิมพ์: เบิก [จำนวนเงิน]\n` +
                         `ตัวอย่าง: เบิก 500\n\n` +
                         `วันศุกร์ (10:00 - 13:00 น.) -> หักหนี้\n` +
                         `พิมพ์: หัก [จำนวนเงิน]\n` +
                         `ตัวอย่าง: หัก 1000\n\n` +
                         `📍 ข้อมูลส่วนตัว\n\n` +
                         `กดเมนู "เช็คสถานะ/ยอดหนี้" หรือพิมพ์ เช็คยอด\n` +
                         `เพื่อดูสถานะการลงเวลา และ ยอดหนี้คงเหลือปัจจุบัน`;

          await client.replyMessage(event.replyToken, { type: 'text', text: manual });
          continue;
      }

      // 4. Admin Manual: เรียกดูคู่มือและวิธีแก้ปัญหา
      if (text === 'คู่มือ admin' || text === 'help admin' || text === 'admin manual') {
          if (!isAdmin) { 
              await client.replyMessage(event.replyToken, { type: 'text', text: '❌ สำหรับ Admin เท่านั้นค่ะ' }); 
              continue; 
          }

          const adminManual = `📘 คู่มือ Admin & Troubleshooting\n` +
            `--------------------------\n` +
            `👑 1. จัดการคน\n` +
            `🔹 รับคนใหม่: add employee [ID] [ชื่อ]\n` +
            `🔹 ลบคนออก: remove employee [ID]\n` +
            `🔹 ดูรายชื่อ: พิมพ์ "รายชื่อ"\n\n` +
            
            `⏰ 2. แก้ปัญหาเวลา (Troubleshooting)\n` +
            `🔸 กดผิด (ก่อน 09:30) -> พิมพ์: ลบเวลา [ID]\n` +
            `🔸 ลืมกด/มาสาย (หลัง 09:30) -> พิมพ์: แก้เวลา [ID] เต็ม\n` +
            `🔸 ลาป่วย/หยุด -> พิมพ์: แก้เวลา [ID] หยุด\n\n` +

            `💰 3. จัดการเงิน\n` +
            `🔹 ปรับค่าแรง: ปรับค่าแรง [ID] [ยอดใหม่]\n` +
            `🔹 ปล่อยกู้เพิ่ม: เพิ่มหนี้ [ID] [จำนวน]\n` +
            `🔹 แก้หนี้ใน Sheet: แก้เสร็จต้องพิมพ์ update data\n\n` +

            `⏳ 4. ตารางเวลาอัตโนมัติ (Schedule)\n` +
            `09:20 : ⚠️ แจ้งเตือนคนยังไม่ลงเวลา\n` +
            `09:30 : ⛔ ปิดระบบลงเวลา\n` +
            `09:45 : 📊 ส่งรายงานคนขาด/ลา ให้ Admin\n` +
            `พุธ : 💸 ถามเบิกเงิน (เช้า) / สรุป (บ่าย)\n` +
            `ศุกร์ : 📉 ถามหักหนี้ (เช้า) / สรุป (บ่าย)\n` +
            `เสาร์ 10:00 : 🧾 ส่งสลิปเงินเดือน & สรุปยอดจ่าย`;

          await client.replyMessage(event.replyToken, { type: 'text', text: adminManual });
          continue;
      }

      if (lower === 'update data') {
          if (!isAdmin) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '❌ Access Denied' });
              continue;
          }
          await client.replyMessage(event.replyToken, { type: 'text', text: '🔄 กำลังดึงข้อมูลล่าสุดจาก Google Sheet...' });
          await loadDataFromSheet();
          await client.pushMessage(userId, { type: 'text', text: '✅ อัปเดตข้อมูลพนักงาน/การเงิน เรียบร้อยแล้วค่ะ!' });
          continue;
      }

      // Admin Management
      // Admin: เพิ่มพนักงานใหม่ (รองรับการใส่ค่าแรงเลย)
      // รูปแบบ 1: add employee [ID] [ชื่อ] (ค่าแรงเป็น 0)
      // รูปแบบ 2: add employee [ID] [ชื่อ] [ค่าแรง]
      // ตัวอย่าง: add employee U123... สมชาย 500
      if (lower.startsWith('add employee')) {
          if(!isAdmin) { await client.replyMessage(event.replyToken, {type:'text', text:'❌ Admin Only'}); continue; }
          
          const parts = text.split(' ');
          // parts[0]=add, parts[1]=employee, parts[2]=ID
          const eid = parts[2];
          
          if(!eid) {
              await client.replyMessage(event.replyToken, {type:'text', text:'⚠️ ใส่ UserID ด้วยค่ะ'}); 
              continue;
          }

          // --- Logic แยกชื่อกับค่าแรง ---
          let rate = 0;
          let nameParts = [];
          
          // เช็คว่าคำสุดท้ายเป็นตัวเลขไหม?
          const lastPart = parts[parts.length - 1];
          const possibleRate = parseInt(lastPart);

          if (!isNaN(possibleRate) && parts.length > 3) {
              // ถ้าคำสุดท้ายเป็นเลข และมีชื่อนำหน้ามา
              rate = possibleRate; // เอาเลขนั้นเป็นค่าแรง
              nameParts = parts.slice(3, parts.length - 1); // เอาคำตรงกลางเป็นชื่อ
          } else {
              // ถ้าไม่มีเลข
              nameParts = parts.slice(3); // เอาข้างหลัง ID ทั้งหมดเป็นชื่อ
          }

          const ename = nameParts.join(' ') || 'Emp';
          // ----------------------------

          // 1. บันทึก Memory
          employees[eid] = { name: ename, active: true, dailyRate: rate, totalDebt: 0 };
          
          // 2. บันทึก Google Sheet (Column F คือค่าแรง, G คือหนี้เริ่มเป็น 0)
          await saveToSheet('employee!A:G', [new Date().toLocaleString('th-TH'), eid, ename, 'active', userId, rate, 0]);
          
          let replyMsg = `✅ เพิ่มพนักงาน: "${ename}" เรียบร้อยค่ะ`;
          if (rate > 0) {
              replyMsg += `\n💰 ค่าแรงเริ่มต้น: ${rate} บาท/วัน`;
          } else {
              replyMsg += `\n(ยังไม่ได้ระบุค่าแรง - สามารถใช้คำสั่ง "ปรับค่าแรง" ทีหลังได้ค่ะ)`;
          }

          await client.replyMessage(event.replyToken, {type:'text', text: replyMsg});
          continue;
      }
      
      if (lower.startsWith('remove employee')) {
          if(!isAdmin) { await client.replyMessage(event.replyToken, {type:'text', text:'❌ Admin Only'}); continue; }
          const [,,eid] = text.split(' ');
          if(employees[eid]) {
             employees[eid].active = false;
             await saveToSheet('employee!A:G', [new Date().toLocaleString('th-TH'), eid, employees[eid].name, 'inactive', userId]);
             await client.replyMessage(event.replyToken, {type:'text', text:`⛔ ลบพนักงาน: ${employees[eid].name} เรียบร้อยค่ะ`});
          }
          continue;
      }

      if (lower.startsWith('add admin')) {
          if(!isAdmin) { await client.replyMessage(event.replyToken, {type:'text', text:'❌ Admin Only'}); continue; }
          const [,,aid, ...n] = text.split(' ');
          const aname = n.join(' ')||'Admin';
          if(!aid) continue;
          
          admins[aid] = { name: aname, active: true };
          await saveToSheet('admin!A:E', [new Date().toLocaleString('th-TH'), aid, aname, 'active', userId]);
          await client.replyMessage(event.replyToken, {type:'text', text:`🛡️ แต่งตั้ง Admin: ${aname} เรียบร้อยค่ะ`});
          continue;
      }

      // Admin: เพิ่มหนี้ (ปล่อยกู้เพิ่ม)
      // พิมพ์: เพิ่มหนี้ U1234xxx 5000
      if (lower.startsWith('เพิ่มหนี้')) {
          if(!isAdmin) { await client.replyMessage(event.replyToken, {type:'text', text:'❌ Admin Only'}); continue; }
          
          const parts = text.split(' ');
          const targetId = parts[1]; // UserID
          const amount = parseInt(parts[2]); // จำนวนเงิน

          if (!targetId || !amount || isNaN(amount)) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ รูปแบบคำสั่งผิดค่ะ\nพิมพ์: เพิ่มหนี้ [UserID] [จำนวนเงิน]\nเช่น: เพิ่มหนี้ U1234... 5000' });
              continue;
          }

          if (!employees[targetId]) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ ไม่พบรหัสพนักงานนี้ในระบบค่ะ' });
              continue;
          }

          // 1. คำนวณหนี้ใหม่ (ของเดิม + ยอดใหม่)
          const oldDebt = employees[targetId].totalDebt || 0;
          const newDebt = oldDebt + amount;

          // 2. อัปเดต Memory
          employees[targetId].totalDebt = newDebt;

          // 3. อัปเดต Google Sheet
          await updateDebtInSheet(targetId, newDebt);

          // 4. (Optional) อาจจะอยากบันทึกลง Sheet 'advance' ด้วยไหม? หรือแค่แก้หนี้เฉยๆ?
          // ถ้าเอาแค่แก้หนี้ก้อนใหญ่ จบที่ข้อ 3 ได้เลยค่ะ

          await client.replyMessage(event.replyToken, { 
              type: 'text', 
              text: `✅ เพิ่มหนี้ให้คุณ ${employees[targetId].name} เรียบร้อยค่ะ\n💰 ยอดเพิ่ม: ${amount.toLocaleString()} บาท\n📉 หนี้รวมปัจจุบัน: ${newDebt.toLocaleString()} บาท` 
          });
          continue;
      }

      // Admin: ปรับค่าแรง (ขึ้นเงินเดือน)
      // พิมพ์: ปรับค่าแรง [UserID] [ยอดใหม่]
      // ตัวอย่าง: ปรับค่าแรง U123... 600
      if (lower.startsWith('ปรับค่าแรง') || lower.startsWith('set rate')) {
          if(!isAdmin) { await client.replyMessage(event.replyToken, {type:'text', text:'❌ Admin Only'}); continue; }
          
          const parts = text.split(' ');
          const targetId = parts[1]; 
          const amount = parseInt(parts[2]); 

          if (!targetId || !amount || isNaN(amount)) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ รูปแบบผิดค่ะ\nพิมพ์: ปรับค่าแรง [UserID] [ยอดใหม่]\nเช่น: ปรับค่าแรง U123... 600' });
              continue;
          }

          if (!employees[targetId]) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ ไม่พบรหัสพนักงานนี้ในระบบค่ะ' });
              continue;
          }

          // 1. อัปเดต Memory
          employees[targetId].dailyRate = amount;

          // 2. อัปเดต Google Sheet (Column F)
          await updateRateInSheet(targetId, amount);

          await client.replyMessage(event.replyToken, { 
              type: 'text', 
              text: `✅ ปรับค่าแรงให้คุณ ${employees[targetId].name} เรียบร้อยค่ะ\n💰 ค่าแรงใหม่: ${amount.toLocaleString()} บาท/วัน` 
          });
          continue;
      }

      // Admin: เรียกดูรายชื่อพนักงานทั้งหมด
      if (lower === 'list employees' || lower === 'รายชื่อ') {
          if (!isAdmin) { await client.replyMessage(event.replyToken, { type: 'text', text: '❌ Admin Only' }); continue; }
          
          let msg = '📋 รายชื่อพนักงาน (Active)\n=================\n';
          let count = 0;

          for (const uid in employees) {
              const emp = employees[uid];
              if (emp.active) {
                  count++;
                  msg += `${count}. ${emp.name}\n`;
                  msg += `🆔: ${uid}\n`; 
                  // เพิ่มบรรทัดค่าแรงตรงนี้
                  msg += `💰 ค่าแรง: ${emp.dailyRate.toLocaleString()} บ./วัน\n`;
                  msg += `📉 หนี้: ${emp.totalDebt.toLocaleString()} บ.\n`;
                  msg += `-----------------\n`;
              }
          }

          if (count === 0) msg += '(ยังไม่มีพนักงานในระบบ)';

          await client.replyMessage(event.replyToken, { type: 'text', text: msg });
          continue;
      }

      /* ===== Admin: จัดการเวลาแทนพนักงาน (Manual Fix) ===== */

      // 1. สั่งแก้เวลา / ลงเวลาแทน (Override)
      // พิมพ์: แก้เวลา [UserID] [เต็ม/เช้า/บ่าย/หยุด]
      // ตัวอย่าง: แก้เวลา U1234... เต็ม
      if (lower.startsWith('แก้เวลา')) {
          if (!isAdmin) { await client.replyMessage(event.replyToken, { type: 'text', text: '❌ Admin Only' }); continue; }

          const parts = text.split(' ');
          const targetId = parts[1];
          const typeInput = parts[2]; // เต็ม, เช้า, บ่าย, หยุด

          if (!targetId || !typeInput) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ รูปแบบผิดค่ะ\nพิมพ์: แก้เวลา [UserID] [เต็ม/เช้า/บ่าย/หยุด]\n(ดู ID จากคำสั่ง "รายชื่อ")' });
              continue;
          }

          // แปลงคำสั่งเป็น Code ระบบ
          let finalType = '';
          let typeTh = '';
          if (['เต็ม', 'full', 'เต็มวัน'].includes(typeInput)) { finalType = 'work:full'; typeTh = 'เต็มวัน'; }
          else if (['เช้า', 'morning'].includes(typeInput)) { finalType = 'work:half-morning'; typeTh = 'ครึ่งเช้า'; }
          else if (['บ่าย', 'afternoon'].includes(typeInput)) { finalType = 'work:half-afternoon'; typeTh = 'ครึ่งบ่าย'; }
          else if (['หยุด', 'off'].includes(typeInput)) { finalType = 'work:off'; typeTh = 'หยุดงาน'; }
          else {
              await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ ใส่ประเภทงานไม่ถูกค่ะ (เลือก: เต็ม/เช้า/บ่าย/หยุด)' });
              continue;
          }

          // 1. อัปเดต Memory (ลบอันเก่าของวันนี้ออกก่อน แล้วใส่ใหม่)
          if (!checkinStore[targetId]) checkinStore[targetId] = [];
          
          // กรองเอาของวันนี้ออก (ถ้ามี)
          checkinStore[targetId] = checkinStore[targetId].filter(r => r.date !== today);
          // ใส่ค่าใหม่เข้าไป
          checkinStore[targetId].push({ date: today, workType: finalType });

          // 2. บันทึกลง Sheet (Append ต่อท้าย เป็น Log การแก้ไข)
          // (หมายเหตุ: ใน Sheet จะมี 2 แถว แต่ใน Memory จะจำอันล่าสุด ซึ่งถูกต้องแล้ว)
          const targetName = employees[targetId]?.name || 'Unknown';
          await saveToSheet('checkin!A:E', [today, targetId, targetName, finalType, new Date().toLocaleString('th-TH') + ' (Admin แก้ไข)']);

          await client.replyMessage(event.replyToken, { 
              type: 'text', 
              text: `✅ แก้ไขเวลาให้คุณ ${targetName} เรียบร้อยค่ะ\n📅 วันที่: ${thaiDate}\n📝 สถานะใหม่: ${typeTh}` 
          });
          continue;
      }

      // 2. สั่งลบเวลาออก (Reset ของวันนี้)
      // พิมพ์: ลบเวลา [UserID]
      if (lower.startsWith('ลบเวลา')) {
          if (!isAdmin) { await client.replyMessage(event.replyToken, { type: 'text', text: '❌ Admin Only' }); continue; }

          const targetId = text.split(' ')[1];
          if (!targetId) { await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ ใส่ UserID ด้วยค่ะ' }); continue; }

          if (checkinStore[targetId]) {
              // ลบ record ของวันนี้ออกจาก Memory
              checkinStore[targetId] = checkinStore[targetId].filter(r => r.date !== today);
          }
          
          const targetName = employees[targetId]?.name || 'Unknown';

          // (Optional) บันทึก Log ว่าถูกลบ
          await saveToSheet('checkin!A:E', [today, targetId, targetName, 'delete-log', new Date().toLocaleString('th-TH') + ' (Admin สั่งลบ)']);

          await client.replyMessage(event.replyToken, { 
              type: 'text', 
              text: `✅ ลบการลงเวลาของวันนี้ให้คุณ ${targetName} แล้วค่ะ\n(พนักงานสามารถกด Check-in ใหม่ได้เลย)` 
          });
          continue;
      }

      /* ===== 1. Check-in Logic ===== */
      if (lower.startsWith('work:')) {
         if (!checkinStore[userId]) checkinStore[userId] = [];
         
         const already = checkinStore[userId].find(r => r.date === today);
         if (already) {
             await client.replyMessage(event.replyToken, { type: 'text', text: `⚠️ วันนี้คุณ ${name} ลงเวลาไปแล้วค่ะ` });
             continue;
         }

         // แปลงสถานะเป็นภาษาไทย
         let statusTh = 'ทำงานเต็มวัน';
         if(lower.includes('half-morning')) statusTh = 'ครึ่งเช้า';
         else if(lower.includes('half-afternoon')) statusTh = 'ครึ่งบ่าย';
         else if(lower.includes('off')) statusTh = 'หยุดงาน';

         checkinStore[userId].push({ date: today, workType: lower });
         await saveToSheet('checkin!A:E', [today, userId, name, lower, new Date().toLocaleString('th-TH')]);
         
         await client.replyMessage(event.replyToken, { 
             type: 'text', 
             text: `✅ บันทึกเวลาเรียบร้อยค่ะ\n👤 ชื่อ: ${name}\n📅 วันที่: ${thaiDate}\n📝 สถานะ: ${statusTh}` 
         });
         continue;
      }
      
      /* ===== 2. เบิกเงิน (ง่ายขึ้น: พิมพ์ "เบิก 500") ===== */
      if (lower.startsWith('berk:') || lower.startsWith('เบิก')) {
          if (new Date().getDay() !== 3) { 
              await client.replyMessage(event.replyToken, { type: 'text', text: '❌ ระบบเบิกเปิดเฉพาะวันพุธค่ะ' });
              continue;
          }
          if (!isTransactionTime()) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '❌ ไม่อยู่ในช่วงเวลาเบิกค่ะ (10:00-13:00)' });
              continue;
          }

          // รองรับทั้ง "berk:500", "เบิก 500", "เบิก500"
          let amountStr = text.replace('berk:', '').replace('เบิก', '').trim();
          const amount = parseInt(amountStr);

          if (!amount || isNaN(amount)) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ กรุณาใส่ตัวเลขด้วยค่ะ เช่น "เบิก 500"' });
              continue;
          }

          weeklyTransactions.advance[userId] = amount;
          await saveToSheet('advance!A:E', [today, userId, name, amount, new Date().toLocaleString('th-TH')]);
          await client.replyMessage(event.replyToken, { 
              type: 'text', 
              text: `✅ ทำรายการเบิกสำเร็จค่ะ\n👤 ชื่อ: ${name}\n💸 ยอดเบิก: ${amount} บาท\n📅 วันที่: ${thaiDate}` 
          });
          continue;
      }

      /* ===== 3. จ่ายหนี้ (ง่ายขึ้น: พิมพ์ "หัก 500" หรือ "คืน 500") ===== */
      if (lower.startsWith('paydebt:') || lower.startsWith('หัก') || lower.startsWith('คืน')) {
          if (new Date().getDay() !== 5) { 
              await client.replyMessage(event.replyToken, { type: 'text', text: '❌ ระบบหักหนี้เปิดเฉพาะวันศุกร์ค่ะ' });
              continue;
          }
          if (!isTransactionTime()) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '❌ ไม่อยู่ในช่วงเวลาค่ะ (10:00-13:00)' });
              continue;
          }

          let amountStr = text.replace('paydebt:', '').replace('หัก', '').replace('คืน', '').trim();
          const amount = parseInt(amountStr);

          if (!amount || isNaN(amount)) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ กรุณาใส่ตัวเลขด้วยค่ะ เช่น "หัก 500"' });
              continue;
          }

          const currentDebt = employees[userId]?.totalDebt || 0;
          if (amount > currentDebt) {
             await client.replyMessage(event.replyToken, { type: 'text', text: `⚠️ ยอดเกินหนี้ที่มี (${currentDebt} บาท) ค่ะ` });
             continue;
          }

          // Logic
          const newDebt = currentDebt - amount;
          if(employees[userId]) employees[userId].totalDebt = newDebt;

          weeklyTransactions.repayment[userId] = amount;
          await saveToSheet('repayment!A:E', [today, userId, name, amount, new Date().toLocaleString('th-TH')]);
          await updateDebtInSheet(userId, newDebt);

          await client.replyMessage(event.replyToken, { 
              type: 'text', 
              text: `✅ ทำรายการหักหนี้สำเร็จค่ะ\n👤 ชื่อ: ${name}\n📉 ยอดหัก: ${amount} บาท\n📉 หนี้คงเหลือ: ${newDebt} บาท\n📅 วันที่: ${thaiDate}` 
          });
          continue;
      }
      
      // ปุ่ม Checkin
      if (lower === 'checkin') {
         if (!isAdmin && !employees[userId]?.active) {
            await client.replyMessage(event.replyToken, { type: 'text', text: '❌ คุณยังไม่ได้เป็นพนักงานในระบบ\nกรุณาติดต่อ Admin ค่ะ' });
            continue;
         }

         if (checkinStore[userId]?.find(r => r.date === today)) {
             await client.replyMessage(event.replyToken, { type: 'text', text: `⚠️ คุณ ${name} คะ วันนี้ลงเวลาไปแล้วค่ะ` });
             continue;
         }

         if (isSunday()) { await client.replyMessage(event.replyToken, {type:'text', text:'❌ วันอาทิตย์หยุดนะคะ'}); continue; }
         if (isAfter0930() && !isAdmin) { await client.replyMessage(event.replyToken, {type:'text', text:'⛔ สายแล้วค่ะ (ระบบปิด 09:30)'}); continue; }

         await client.replyMessage(event.replyToken, {
          type: 'template',
          altText: 'Check-in',
          template: {
            type: 'buttons',
            text: `${thaiDate}\nคุณ ${name} วันนี้ทำงานแบบไหนคะ?`,
            actions: [
              { label: 'เต็มวัน', type: 'message', text: 'work:full' },
              { label: 'ครึ่งเช้า', type: 'message', text: 'work:half-morning' },
              { label: 'ครึ่งบ่าย', type: 'message', text: 'work:half-afternoon' },
              { label: 'หยุด', type: 'message', text: 'work:off' },
            ],
          },
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
   Start Server
====================== */
const PORT = process.env.PORT || 3000;
loadDataFromSheet().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
});