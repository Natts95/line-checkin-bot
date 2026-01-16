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
// เก็บ Check-in รายสัปดาห์ (Key = userId) -> Array of objects
let checkinStore = {}; 

// เก็บธุรกรรมรายสัปดาห์
let weeklyTransactions = {
    advance: {}, 
    repayment: {} 
};

const employees = {}; // { userId: { name, active, dailyRate, totalDebt } }
const admins = {};

/* ======================
   Google Sheets Functions
====================== */

// 1. General Save Function
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

// 2. ฟังก์ชันอัปเดตหนี้ (Auto Deduct)
async function updateDebtInSheet(targetUserId, newDebtAmount) {
  try {
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });

    // อ่านข้อมูลเพื่อหาบรรทัด
    const readRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'employee!B:B', 
    });

    const rows = readRes.data.values;
    if (!rows || rows.length === 0) return;

    let targetRow = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === targetUserId) {
        targetRow = i + 1; // +1 เพราะ Sheet เริ่มนับที่ 1
        break;
      }
    }

    if (targetRow === -1) {
      console.log(`❌ ไม่พบ UserID: ${targetUserId} เพื่ออัปเดตหนี้`);
      return;
    }

    // อัปเดตช่อง G (TotalDebt)
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `employee!G${targetRow}`, 
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[newDebtAmount]] },
    });

    console.log(`✅ อัปเดตหนี้ใหม่ใน Sheet เรียบร้อย: แถว ${targetRow}, ยอด ${newDebtAmount}`);
  } catch (err) {
    console.error('❌ UPDATE DEBT ERROR:', err.message);
  }
}

// 3. Load Employees + Financial Data
async function loadDataFromSheet() {
  console.log('🔄 Loading data...');
  try {
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });

    // Load Emp (Col A-G)
    const empRes = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: 'employee!A:G' });
    if (empRes.data.values) {
        empRes.data.values.forEach(row => {
            const [, uid, name, status, , rate, debt] = row;
            if(!uid || uid === 'UserId') return;
            
            if(status === 'active') {
                employees[uid] = { 
                    name, 
                    active: true,
                    dailyRate: parseInt(rate) || 0,
                    totalDebt: parseInt(debt) || 0
                };
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

    // Load Checkins Today (กันระบบ Restart แล้วลืมว่าใครเช็คอินแล้ว)
    const today = getToday();
    const checkinRes = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: 'checkin!A:E' });
    if (checkinRes.data.values) {
        checkinRes.data.values.forEach(row => {
            // row[0]=date, row[1]=uid, row[3]=workType
            if(row[0] === today) {
                if(!checkinStore[row[1]]) checkinStore[row[1]] = [];
                // เช็คว่ามีใน array หรือยังเพื่อกันซ้ำใน memory
                const exists = checkinStore[row[1]].find(r => r.date === today);
                if(!exists) checkinStore[row[1]].push({ date: row[0], workType: row[3] });
            }
        });
    }

    console.log(`✅ Loaded: ${Object.keys(employees).length} Employees`);
  } catch(e) { console.error(e); }
}

/* ======================
   Helpers & Time Logic
====================== */
function getToday() { return new Date().toISOString().split('T')[0]; }
function isSunday() { return new Date().getDay() === 0; }
function isAfter0930() { 
  const d = new Date(); 
  return d.getHours() > 9 || (d.getHours() === 9 && d.getMinutes() >= 30); 
}
function formatThaiDate() {
    const d = new Date();
    const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()+543}`;
}
function isTransactionTime() {
    const d = new Date();
    const hour = d.getHours();
    return hour >= 10 && hour < 13; // 10:00 - 12:59
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
        try { await client.pushMessage(uid, { type: 'text', text: `⚠️ อีก 10 นาทีปิด Check-in ครับ` }); } 
        catch (e) {}
      }
    }
  }
}, { timezone: "Asia/Bangkok" });

// 2. 09:45 -> รายงาน Admin (จันทร์-เสาร์)
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


/* ============ 💰 FINANCE CRON JOBS ============ */

// 3. พุธ 10:00 -> เปิดให้เบิกเงิน
cron.schedule('0 10 * * 3', async () => { 
    for (const uid in employees) {
        if (!employees[uid].active) continue;
        await client.pushMessage(uid, {
            type: 'template',
            altText: 'ต้องการเบิกเงินวันนี้ไหมครับ?',
            template: {
                type: 'confirm',
                text: `💸 วันพุธแล้ว ต้องการ "เบิกเงินล่วงหน้า" ไหมครับ?\n(หมดเวลา 13:00 น.)`,
                actions: [
                    { label: 'ต้องการ', type: 'postback', data: 'req_advance:yes' },
                    { label: 'ไม่ต้องการ', type: 'message', text: 'ไม่เบิกครับ' }
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
        msg += `${employees[uid]?.name || uid}: ${weeklyTransactions.advance[uid]} บ.\n`;
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
            altText: 'ต้องการหักหนี้วันนี้ไหมครับ?',
            template: {
                type: 'confirm',
                text: `📉 วันศุกร์แล้ว หักหนี้ไหมครับ?\n(หนี้คงเหลือ: ${currentDebt} บ.)`,
                actions: [
                    { label: 'หักหนี้', type: 'postback', data: 'req_repayment:yes' },
                    { label: 'ไม่หัก', type: 'message', text: 'ไม่หักหนี้ครับ' }
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
        msg += `${employees[uid]?.name || uid}: ${weeklyTransactions.repayment[uid]} บ.\n`;
        total += weeklyTransactions.repayment[uid];
    }
    msg += `----------------\nรวม: ${total} บาท`;
    await client.pushMessage(process.env.ADMIN_USER_ID, { type: 'text', text: msg });
}, { timezone: "Asia/Bangkok" });

// 7. เสาร์ 10:00 -> Payroll Report
cron.schedule('0 10 * * 6', async () => { 
    let adminReport = `💰 รายงานสรุปค่าแรงประจำสัปดาห์\n${formatThaiDate()}\n=====================\n`;
    
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
        const remainingDebt = emp.totalDebt; // หนี้ที่เหลือหลังจากหักวันศุกร์ไปแล้ว

        // ส่งสลิป
        const slip = `🧾 สลิปเงินเดือน (Weekly)\nคุณ: ${emp.name}\n` +
                     `ทำงาน: ${fullDays} วันเต็ม, ${halfDays} ครึ่งวัน\n` +
                     `ค่าแรงรวม: ${grossPay.toLocaleString()} บ.\n` +
                     `หักเบิกวันพุธ: -${advance.toLocaleString()} บ.\n` +
                     `หักชำระหนี้: -${debtPaid.toLocaleString()} บ.\n` +
                     `-----------------------\n` +
                     `💰 รับสุทธิ: ${netPay.toLocaleString()} บาท\n` +
                     `(หนี้คงเหลือ: ${remainingDebt.toLocaleString()} บ.)`;
        
        await client.pushMessage(uid, { type: 'text', text: slip }).catch(()=>{});

        // รายงาน Admin
        adminReport += `👤 ${emp.name}\n   งาน: ${workDaysCount}วัน, จ่ายสุทธิ: ${netPay} บ.\n`;
    }

    await client.pushMessage(process.env.ADMIN_USER_ID, { type: 'text', text: adminReport }).catch(()=>{});
    
    // Reset Transaction รายสัปดาห์ (แต่ Checkin เก็บไว้ก่อนเผื่อดูย้อนหลัง)
    weeklyTransactions = { advance: {}, repayment: {} };

}, { timezone: "Asia/Bangkok" });


/* ======================
   Webhook
====================== */
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    for (const event of req.body.events) {
      const userId = event.source.userId;
      // Admin Check: เป็น Super Admin หรืออยู่ในรายชื่อ Admin Active
      const isSuperAdmin = userId === process.env.ADMIN_USER_ID;
      const isAdmin = isSuperAdmin || admins[userId]?.active;
      
      // Handle Postback
      if (event.type === 'postback') {
          const data = event.postback.data;
          
          if (data === 'req_advance:yes') {
             if (!isTransactionTime()) {
                 await client.replyMessage(event.replyToken, { type: 'text', text: '❌ หมดเวลาทำรายการแล้วครับ (10:00-13:00)' });
                 continue;
             }
             await client.replyMessage(event.replyToken, { type: 'text', text: 'กรุณาพิมพ์ยอดเงินที่ต้องการเบิก\nเช่น "berk:500"' });
          }

          if (data === 'req_repayment:yes') {
             if (!isTransactionTime()) {
                 await client.replyMessage(event.replyToken, { type: 'text', text: '❌ หมดเวลาทำรายการแล้วครับ (10:00-13:00)' });
                 continue;
             }
             await client.replyMessage(event.replyToken, { type: 'text', text: 'กรุณาพิมพ์ยอดหนี้ที่ต้องการหัก\nเช่น "paydebt:500"' });
          }
          continue;
      }

      if (event.type !== 'message' || event.message.type !== 'text') continue;
      const text = event.message.text.trim();
      const lower = text.toLowerCase();
      const today = getToday();

      const profile = await client.getProfile(userId);
      const name = profile.displayName;

      /* ===== 0. Utility Commands ===== */
      
      // whoami
      if (lower === 'whoami') {
        let role = 'Guest';
        if (isSuperAdmin) role = '👑 Super Admin';
        else if (isAdmin) role = '🛡️ Admin';
        else if (employees[userId]?.active) role = '💼 Employee';
        
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `👤 ${name}\nID: ${userId}\nRole: ${role}`
        });
        continue;
      }

      // update data (New!)
      if (lower === 'update data') {
          if (!isAdmin) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '❌ Access Denied' });
              continue;
          }
          await client.replyMessage(event.replyToken, { type: 'text', text: '🔄 กำลังดึงข้อมูลล่าสุดจาก Google Sheet...' });
          await loadDataFromSheet();
          await client.pushMessage(userId, { type: 'text', text: '✅ อัปเดตข้อมูลพนักงาน/การเงิน เรียบร้อยแล้วครับ!' });
          continue;
      }

      // Admin Management (Add/Remove)
      if (lower.startsWith('add employee')) {
          if(!isAdmin) { await client.replyMessage(event.replyToken, {type:'text', text:'❌ Admin Only'}); continue; }
          const [,,eid, ...n] = text.split(' ');
          const ename = n.join(' ')||'Emp';
          if(!eid) continue;
          
          employees[eid] = { name: ename, active: true, dailyRate: 0, totalDebt: 0 };
          await saveToSheet('employee!A:G', [new Date().toLocaleString('th-TH'), eid, ename, 'active', userId, 0, 0]);
          await client.replyMessage(event.replyToken, {type:'text', text:`✅ Added Employee: ${ename}\n(อย่าลืมไปใส่ค่าแรง/หนี้ใน Sheet และกด update data)`});
          continue;
      }
      
      if (lower.startsWith('remove employee')) {
          if(!isAdmin) { await client.replyMessage(event.replyToken, {type:'text', text:'❌ Admin Only'}); continue; }
          const [,,eid] = text.split(' ');
          if(employees[eid]) {
             employees[eid].active = false;
             await saveToSheet('employee!A:G', [new Date().toLocaleString('th-TH'), eid, employees[eid].name, 'inactive', userId]);
             await client.replyMessage(event.replyToken, {type:'text', text:`⛔ Removed: ${employees[eid].name}`});
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
          await client.replyMessage(event.replyToken, {type:'text', text:`🛡️ Added Admin: ${aname}`});
          continue;
      }


      /* ===== 1. Check-in Logic ===== */
      if (lower.startsWith('work:')) {
         if (!checkinStore[userId]) checkinStore[userId] = [];
         
         const already = checkinStore[userId].find(r => r.date === today);
         if (already) {
             await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ วันนี้คุณ${emp.name}ลงเวลาไปแล้วครับ' });
             continue;
         }

         checkinStore[userId].push({ date: today, workType: lower });
         await saveToSheet('checkin!A:E', [today, userId, name, lower, new Date().toLocaleString('th-TH')]);
         await client.replyMessage(event.replyToken, { type: 'text', text: '✅ บันทึกเวลาของคุณ${emp.name}เรียบร้อยครับ' });
         continue;
      }
      
      /* ===== 2. เบิกเงิน (Wednesday) ===== */
      if (lower.startsWith('berk:')) {
          if (new Date().getDay() !== 3) { 
              await client.replyMessage(event.replyToken, { type: 'text', text: '❌ ระบบเบิกเปิดเฉพาะวันพุธครับ' });
              continue;
          }
          if (!isTransactionTime()) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '❌ ไม่อยู่ในช่วงเวลาเบิก (10:00-13:00)' });
              continue;
          }

          const amount = parseInt(text.split(':')[1]);
          if (!amount || isNaN(amount)) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ ใส่ตัวเลขด้วยครับ เช่น berk:500' });
              continue;
          }

          weeklyTransactions.advance[userId] = amount;
          await saveToSheet('advance!A:E', [today, userId, name, amount, new Date().toLocaleString('th-TH')]);
          await client.replyMessage(event.replyToken, { type: 'text', text: `✅ บันทึกยอดเบิก ${amount} บาท เรียบร้อย` });
          continue;
      }

      /* ===== 3. จ่ายหนี้ (Friday) + Auto Update Sheet ===== */
      if (lower.startsWith('paydebt:')) {
          if (new Date().getDay() !== 5) { 
              await client.replyMessage(event.replyToken, { type: 'text', text: '❌ ระบบหักหนี้เปิดเฉพาะวันศุกร์ครับ' });
              continue;
          }
          if (!isTransactionTime()) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '❌ ไม่อยู่ในช่วงเวลา (10:00-13:00)' });
              continue;
          }

          const amount = parseInt(text.split(':')[1]);
          if (!amount || isNaN(amount)) {
              await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ ใส่ตัวเลขด้วยครับ เช่น paydebt:500' });
              continue;
          }

          const currentDebt = employees[userId]?.totalDebt || 0;
          if (amount > currentDebt) {
             await client.replyMessage(event.replyToken, { type: 'text', text: `⚠️ ยอดเกินหนี้ที่มี (${currentDebt} บาท) ครับ` });
             continue;
          }

          // --- 🌟 LOGIC ใหม่: หักลบหนี้และอัปเดต Sheet ทันที ---
          const newDebt = currentDebt - amount;
          
          // 1. Update Memory
          if(employees[userId]) employees[userId].totalDebt = newDebt;

          // 2. Save Transaction Log
          weeklyTransactions.repayment[userId] = amount;
          await saveToSheet('repayment!A:E', [today, userId, name, amount, new Date().toLocaleString('th-TH')]);

          // 3. Update TotalDebt in Sheet
          await updateDebtInSheet(userId, newDebt);

          await client.replyMessage(event.replyToken, { 
              type: 'text', 
              text: `✅ บันทึกหักหนี้ ${amount} บาท เรียบร้อย\n📉 หนี้คงเหลือ: ${newDebt} บาท` 
          });
          continue;
      }
      
      // ปุ่ม Checkin
      if (lower === 'checkin') {
         if (!isAdmin && !employees[userId]?.active) {
            await client.replyMessage(event.replyToken, { type: 'text', text: '❌ คุณยังไม่ได้เป็นพนักงานในระบบ\nกรุณาติดต่อ admin' });
            continue;
         }

         // เช็คว่าลงหรือยัง
         if (checkinStore[userId]?.find(r => r.date === today)) {
             await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ วันนี้คุณ${emp.name}ลงเวลาไปแล้วครับ' });
             continue;
         }

         if (isSunday()) { await client.replyMessage(event.replyToken, {type:'text', text:'❌ คุณ${emp.name}\nวันอาทิตย์วันหยุดครับ'}); continue; }
         if (isAfter0930() && !isAdmin) { await client.replyMessage(event.replyToken, {type:'text', text:'⛔ ${emp.name}\nสายแล้วครับ (ระบบปิด 09:30)'}); continue; }

         const thaiDate = formatThaiDate();
         await client.replyMessage(event.replyToken, {
          type: 'template',
          altText: 'Check-in',
          template: {
            type: 'buttons',
            text: `${thaiDate}\n${name} ทำงานแบบไหนครับ?`,
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