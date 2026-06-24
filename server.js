const express = require("express");          
const mysql = require("mysql2");            
const path = require("path");              
const session = require("express-session"); 
const bcrypt = require("bcryptjs");         
const multer = require("multer");           
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");
require('dotenv').config(); 

const app = express(); 

// ================= ၂။ MULTER STORAGE SETUP =================
const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, "photo/"); },
    filename: (req, file, cb) => { cb(null, Date.now() + path.extname(file.originalname)); }
});
const upload = multer({ storage: storage });

// ================= ၃။ MIDDLEWARES =================
app.use(express.json());                                 
app.use(express.urlencoded({ extended: true })); 
app.use(express.static(path.join(__dirname, "photo")));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views")); 

app.use(session({
    secret: "secret",         
    resave: false,            
    saveUninitialized: true   
}));

// ================= ၄။ DATABASE CONNECTION =================
const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    
    // ➡️ ဒီစာသား ၃ ကြောင်းကို ကော်ပီကူးပြီး သေချာထည့်ပေးပါဗျာ (Aiven အတွက် အဓိက လိုအပ်ချက်ပါ)
    ssl: {
        rejectUnauthorized: false
    },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ================= ၅။ ADMIN စစ်ဆေးသည့်ဂိတ် =================
function isAdmin(req, res, next) {
    if (!req.session || !req.session.user) return res.redirect("/login");
    if (req.session.user.role !== 'admin') return res.status(403).send("<h1>❌ Access Denied</h1>");
    next();
}

// ================= ၆။ ROUTES =================
app.get("/", (req, res) => { res.send("<h1>🚀 Server is Running Successfully on Railway!</h1>"); });
app.get("/home", (req, res) => { res.render("home"); });
app.get("/about", (req, res) => { res.render("about"); });
app.get("/contact", (req, res) => { res.render("contact"); });

// --- PRODUCT LIST ---
app.get("/list", (req, res) => {
    db.query("SELECT * FROM products", (err, result) => {
        if (err) return res.send("DB Error"); 
        res.render("list", { products: result });
    });
});

// --- CART PAGE ---
app.get("/cart", (req, res) => {
    if (!req.session || !req.session.user || !req.session.user.id) return res.redirect("/login");
    const user_id = req.session.user.id;
    const sql = `SELECT cart.id, cart.quantity, products.name, products.price, products.image FROM cart JOIN products ON cart.product_id = products.id WHERE cart.user_id = ?`;
    db.query(sql, [user_id], (err, result) => {
        if (err) return res.send("Cart Page Error");
        res.render("cart", { carts: result });
    });
});

// --- ADD TO CART ---
app.post("/add-cart", (req, res) => {
    if (!req.session || !req.session.user || !req.session.user.id) return res.redirect("/login");
    const product_id = req.body.product_id; 
    const user_id = req.session.user.id;     

    db.query("SELECT * FROM cart WHERE product_id = ? AND user_id = ?", [product_id, user_id], (err, result) => {
        if (err) return res.send("Cart Error: " + err.message);
        if (result.length > 0) {
            db.query("UPDATE cart SET quantity = quantity + 1 WHERE product_id = ? AND user_id = ?", [product_id, user_id], () => res.redirect("/cart"));
        } else {
            db.query("INSERT INTO cart(user_id, product_id, quantity) VALUES(?, ?, 1)", [user_id, product_id], () => res.redirect("/cart"));
        }
    });
});

app.get("/cart/increase/:id", (req, res) => { db.query("UPDATE cart SET quantity = quantity + 1 WHERE id=?", [req.params.id], () => res.redirect("/cart")); });
app.get("/cart/decrease/:id", (req, res) => { db.query("UPDATE cart SET quantity = quantity - 1 WHERE id=? AND quantity > 1", [req.params.id], () => res.redirect("/cart")); });
app.get("/cart/delete/:id", (req, res) => { db.query("DELETE FROM cart WHERE id=?", [req.params.id], () => res.redirect("/cart")); });

// --- CHECKOUT PAGE ---
app.get("/checkout", (req, res) => {
    if (!req.session || !req.session.user) return res.redirect("/login");
    const userId = req.session.user.id;

    db.query("SELECT name, email FROM users WHERE id = ?", [userId], (err, userResult) => {
        if (err || userResult.length === 0) return res.send("User DB error");
        const loggedInUser = userResult[0]; 

        const sql = `SELECT cart.quantity, products.price FROM cart JOIN products ON cart.product_id = products.id WHERE cart.user_id = ?`;
        db.query(sql, [userId], (err, result) => {
            if (err) return res.send("DB error");
            if (!result || result.length === 0) return res.send("<h1>🛒 ခြင်းတောင်းထဲမှာ ပစ္စည်းမရှိပါ။</h1>");

            let total_amount = 0;
            result.forEach(item => { total_amount += (Number(item.price) * item.quantity); });
            res.render("checkout", { total_amount: Number(total_amount), user: loggedInUser });
        });
    });
});

// --- PLACE ORDER ROUTE ---
app.post("/place-order", (req, res) => {
    if (!req.session || !req.session.user) return res.redirect("/login");

    upload.single("screenshot")(req, res, function (err) {
        if (err) return res.send("Multer Upload Error: " + err.message);

        const bodyData = req.body || {};
        const customer_name    = bodyData.customer_name;
        const phone_number     = bodyData.phone_number;
        const shipping_address = bodyData.shipping_address;
        const total_amount     = bodyData.total_amount;
        let payment_method     = bodyData.payment_method || "COD";
        
        if (payment_method === "COD") payment_method = "Cash on Delivery";
        if (payment_method === "Kpay") payment_method = "KPay";

        if (!customer_name) return res.send("<h1>❌ Form Data ပျောက်ဆုံးနေပါသည်။</h1>");

        const user_id = req.session.user.id;
        const screenshot_image = req.file ? req.file.filename : null; 

        const orderSql = `INSERT INTO orders (user_id, customer_name, phone_number, shipping_address, payment_method, total_amount, payment_screenshot, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed')`;

        db.query(orderSql, [user_id, customer_name, phone_number, shipping_address, payment_method, total_amount, screenshot_image], (err, orderResult) => {
            if (err) return res.send("Order Table Insert Error: " + err.message);

            const insertedOrderId = orderResult.insertId;
            const cartSql = `SELECT cart.product_id, cart.quantity, products.price FROM cart JOIN products ON cart.product_id = products.id WHERE cart.user_id = ?`;

            db.query(cartSql, [user_id], (err, cartItems) => {
                if (err) return res.send("Cart Items Fetch Error: " + err.message);

                let completedInserts = 0;
                cartItems.forEach(item => {
                    const itemSql = "INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)";
                    db.query(itemSql, [insertedOrderId, item.product_id, item.quantity, item.price], (err) => {
                        if (err) console.log(err);
                        completedInserts++;
                        if (completedInserts === cartItems.length) {
                            db.query("DELETE FROM cart WHERE user_id = ?", [user_id], () => {
                                res.send("<h1>🛒 အော်ဒါတင်ခြင်း အောင်မြင်ပါသည်!</h1><a href='/home'>ပင်မစာမျက်နှာသို့ ပြန်ရန်</a>");
                            });
                        }
                    });
                });
            });
        });
    });
});

// --- ADMIN ORDERS VIEW ---
app.get("/admin/orders", isAdmin, (req, res) => {
    const sql = "SELECT * FROM orders ORDER BY id DESC";
    db.query(sql, (err, orderList) => {
        if (err) return res.send("Orders Fetch Error: " + err.message);
        res.render("admin_orders", { orders: orderList });
    });
});

// --- ADMIN MANAGEMENT ---
app.get("/admin", isAdmin, (req, res) => {
    db.query("SELECT * FROM products ORDER BY id DESC", (err, result) => res.render("admin", { products: result }));
});
app.post("/admin/add", isAdmin, (req, res) => {
    const { name, price, image } = req.body;
    db.query("INSERT INTO products(name, price, image) VALUES(?,?, ?) ", [name, price, image], () => res.redirect("/admin"));
});
app.get("/admin/edit/:id", isAdmin, (req, res) => {
    db.query("SELECT * FROM products WHERE id=?", [req.params.id], (err, result) => res.render("edit", { product: result[0] }));
});
app.post("/admin/edit/:id", isAdmin, (req, res) => {
    const { name, price, image } = req.body;
    db.query("UPDATE products SET name=?, price=?, image=? WHERE id=?", [name, price, image, req.params.id], () => res.redirect("/admin"));
});
app.get("/admin/delete/:id", isAdmin, (req, res) => {
    db.query("DELETE FROM cart WHERE product_id = ?", [req.params.id], () => {
        db.query("DELETE FROM products WHERE id = ?", [req.params.id], () => res.redirect("/admin"));
    });
});

// --- WEB AUTHENTICATION & REGISTER WITH OTP ---
app.get("/register", (req, res) => { 
    res.render("register", { error: null }); 
});

app.post("/register", (req, res) => {
    const { name, email, password } = req.body;

    // ➡️ ပြင်ဆင်ချက်: result နေရာတွင် results အဖြစ်ပြောင်းလဲပြီး Error handling စနစ်တကျလုပ်ထားသည်
    db.query("SELECT email FROM users WHERE email = ?", [email], async (err, results) => {
        if (err) {
            console.error("Database Error (SELECT):", err);
            return res.render("register", { error: "Database Error တက်နေပါသည်။" });
        }
        
        // mysql2 အတွက် results.length ကို စိတ်ချရအောင် စစ်ဆေးခြင်း
        if (results && results.length > 0) {
            return res.render("register", { error: "ဒီ Email က သုံးပြီးသားပါ!" });
        }

        const otpCode = Math.floor(100000 + Math.random() * 900000);
        const saveOtpSql = "INSERT INTO otp_table (email, code, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))";
        
        db.query(saveOtpSql, [email, otpCode], async (otpErr) => {
            if (otpErr) {
                console.error("Database Error (INSERT OTP):", otpErr);
                return res.render("register", { error: "OTP သိမ်းဆည်းမှု အမှားအယွင်းရှိပါသည်။" });
            }

            const transporter = nodemailer.createTransport({
                service: "gmail",
                auth: {
                    user: "htoothwin055@gmail.com", 
                    pass: "rrad rhsx hjjg kswn"          
                }
            });

            const mailOptions = {
                from: "htoothwin055@gmail.com",
                to: email,
                subject: "သင်၏ အကောင့်ဖွင့်ရန် အတည်ပြုကုဒ် (OTP)",
                text: `သင်၏ OTP ကုဒ်နံပါတ်မှာ ${otpCode} ဖြစ်ပါသည်။ ၅ မိနစ်အတွင်း အသုံးပြုပါ။`
            };

            transporter.sendMail(mailOptions, async (mailErr) => {
                if (mailErr) {
                    console.error("Mail Send Error:", mailErr);
                    return res.render("register", { error: "Mail ပို့၍မရပါ။ Gmail setting ပြန်စစ်ပါ။" });
                }

                // OTP အောင်မြင်စွာ ထွက်သွားမှ Password ကို hash လုပ်ပြီး session ထဲသိမ်းမည်
                try {
                    const hashedPassword = await bcrypt.hash(password, 10);
                    req.session.tempUser = { name, email, password: hashedPassword };
                    res.redirect("/verify-otp"); 
                } catch (hashErr) {
                    console.error("Bcrypt Error:", hashErr);
                    return res.render("register", { error: "Password ကာကွယ်မှု စနစ်ချို့ယွင်းချက်ရှိပါသည်။" });
                }
            });
        });
    });
});

app.get("/verify-otp", (req, res) => {
    if (!req.session.tempUser) return res.redirect("/register");
    res.render("verify", { error: null, email: req.session.tempUser.email }); 
});

app.post("/verify-otp", (req, res) => {
    if (!req.session.tempUser) return res.redirect("/register");

    const { name, email, password } = req.session.tempUser;
    const { userEnteredCode } = req.body; 

    const checkOtpSql = "SELECT code FROM otp_table WHERE email = ? AND expires_at > NOW() ORDER BY id DESC LIMIT 1";
    
    db.query(checkOtpSql, [email], (err, result) => {
        if (err) return res.render("verify", { error: "စနစ်ချို့ယွင်းမှုရှိပါသည်။", email });
        if (result.length === 0) return res.render("verify", { error: "OTP ကုဒ် သက်တမ်းကုန်သွားပါပြီ သို့မဟုတ် မရှိပါ။", email });

        const correctCodeFromDB = result[0].code;

        if (userEnteredCode === correctCodeFromDB) {
            db.query("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", [name, email, password], (insertErr) => {
                if (insertErr) return res.render("verify", { error: "အကောင့်ဆောက်၍မရပါ၊ ထပ်မံကြိုးစားပါ။", email });
                
                delete req.session.tempUser;
                db.query("DELETE FROM otp_table WHERE email = ?", [email]); 
                res.redirect("/login"); 
            });
        } else {
            res.render("verify", { error: "အတည်ပြုကုဒ် မှားယွင်းနေပါသည်။", email });
        }
    });
});

// --- WEB LOGIN & LOGOUT ---
app.get("/login", (req, res) => { 
    res.render("login", { error: null }); 
});

app.post("/login", (req, res) => {
    const { email, password } = req.body;
    
    // ➡️ ပြင်ဆင်ချက်: result အစား results လို့ သုံးပြီး err handling ထည့်သွင်းထားသည်
    db.query("SELECT * FROM users WHERE email = ?", [email], async (err, results) => {
        if (err) {
            console.error("Database Error (Login):", err);
            return res.render("login", { error: "Database ချိတ်ဆက်မှု Error တက်နေပါသည်။" });
        }

        // mysql2 အတွက် results ရှိမရှိနှင့် အကောင့် ရှိမရှိ သေချာအောင် စစ်ဆေးခြင်း
        if (!results || results.length === 0) { 
            return res.render("login", { error: "Email သို့မဟုတ် Password မှားနေပါတယ်။" }); 
        }

        const user = results[0];
        
        try {
            // သင့်ရဲ့ မူရင်း Password တိုက်စစ်တဲ့ logic အတိုင်း ပြန်သုံးထားပါတယ်
            let isMatch = user.password.startsWith("$2b$") 
                ? await bcrypt.compare(password, user.password) 
                : (password === user.password);

            if (isMatch) {
                let userRole = (user.email === 'admin@gmail.com') ? 'admin' : 'user';
                req.session.user = { id: user.id, name: user.name, email: user.email, role: userRole };
                
                return (userRole === 'admin') ? res.redirect("/admin") : res.redirect("/home");
            } else {
                return res.render("login", { error: "Email သို့မဟုတ် Password မှားနေပါတယ်။" });
            }
        } catch (bcryptErr) {
            console.error("Bcrypt Verification Error:", bcryptErr);
            return res.render("login", { error: "စနစ်ချို့ယွင်းချက်ရှိပါသည်။ ခဏနေမှ ပြန်စမ်းပါ။" });
        }
    });
});
app.get("/logout", (req, res) => { req.session.destroy(() => res.redirect("/login")); });

// ================= ၇။ OTP SYSTEM API ROUTES (FOR POSTMAN & ANDROID STUDIO) =================

// Android မှတစ်ဆင့် Register လုပ်ရန် နှိပ်လျှင် OTP အရင်ပို့ပေးမည့် API
app.post("/api/send-otp", (req, res) => {
    const { email } = req.body;
    const otpCode = Math.floor(100000 + Math.random() * 900000);

    const saveOtpSql = "INSERT INTO otp_table (email, code, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))";
    db.query(saveOtpSql, [email, otpCode], (dbErr) => {
        if (dbErr) return res.status(500).json({ success: false, message: "DB Error" });

        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: "htoothwin055@gmail.com", 
                pass: "rrad rhsx hjjg kswn"     
            }
        });

        const mailOptions = {
            from: "htoothwin055@gmail.com",
            to: email,
            subject: "သင်၏ အကောင့်အတည်ပြုရန် ကုဒ် (OTP)",
            text: `သင်၏ OTP ကုဒ်နံပါတ်မှာ ${otpCode} ဖြစ်ပါသည်။ ၅ မိနစ်အတွင်း အသုံးပြုပါ။`
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) return res.status(500).json({ success: false, message: "Mail ပို့၍မရပါ: " + error.message });
            res.json({ success: true, message: "သင့် Gmail ထဲသို့ ကုဒ်ပို့ပေးလိုက်ပါပြီ။" });
        });
    });
});

// Android မှ ဖြည့်လိုက်သော OTP မှန်ကန်လျှင် User Table ထဲ တန်းသိမ်းပေးမည့် Register API
app.post("/api/verify-otp-register", async (req, res) => {
    const { name, email, password, userEnteredCode } = req.body;

    const checkOtpSql = "SELECT code FROM otp_table WHERE email = ? AND expires_at > NOW() ORDER BY id DESC LIMIT 1";
    
    db.query(checkOtpSql, [email], async (err, result) => {
        if (err) return res.status(500).json({ success: false, message: "Database Error" });
        if (result.length === 0) return res.status(400).json({ success: false, message: "OTP သက်တမ်းကုန်ဆုံးသွားပြီ သို့မဟုတ် မရှိပါ။" });

        if (userEnteredCode === result[0].code) {
            const hashedPassword = await bcrypt.hash(password, 10);
            db.query("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", [name, email, hashedPassword], (insertErr) => {
                if (insertErr) return res.status(500).json({ success: false, message: "အကောင့်ဆောက်၍မရပါ၊ ထပ်မံကြိုးစားပါ။" });
                
                db.query("DELETE FROM otp_table WHERE email = ?", [email]); 
                res.json({ success: true, message: "Android အကောင့်ဖွင့်ခြင်း အောင်မြင်ပါသည်။" });
            });
        } else {
            res.status(400).json({ success: false, message: "အတည်ပြုကုဒ် မှားယွင်းနေပါသည်။" });
        }
    });
});

// Android Mobile App မှ လှမ်းဝင်ရန် Android Login API (JSON ပြန်ပေးမည်)
app.post("/api/login", (req, res) => {
    const { email, password } = req.body;
    db.query("SELECT * FROM users WHERE email = ?", [email], async (err, result) => {
        if (err) return res.status(500).json({ success: false, message: "Database Error" });
        if (result.length === 0) return res.status(400).json({ success: false, message: "Email သို့မဟုတ် Password မှားနေပါတယ်။" });
        
        const user = result[0];
        let isMatch = user.password.startsWith("$2b$") ? await bcrypt.compare(password, user.password) : (password === user.password);

        if (isMatch) {
            res.json({ success: true, message: "Login အောင်မြင်ပါသည်", user: { id: user.id, name: user.name, email: user.email } });
        } else {
            res.status(400).json({ success: false, message: "Email သို့မဟုတ် Password မှားနေပါတယ်။" });
        }
    });
});


// ================= ၈။ SERVER START =================
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });