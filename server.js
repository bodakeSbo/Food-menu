const twilio = require("twilio");
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(cors());
app.use(express.json());

/* =========================
   SUPABASE SETUP
========================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* =========================
   GITHUB SETUP
========================= */
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OWNER = "bodakeSbo";
const REPO = "Food-menu";

/* =========================
   TWILIO WHATSAPP SETUP
========================= */

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/* =========================
   RAZORPAY SETUP
========================= */

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

/* =========================
   CREATE RAZORPAY ORDER
========================= */

app.post("/create-order", async (req, res) => {

  try {

    const { amount } = req.body;

    if (!amount || amount <= 0) {

      return res.status(400).json({
        success: false,
        message: "Invalid amount"
      });

    }

    const options = {
      amount: amount * 100,
      currency: "INR",
      receipt: `receipt_${Date.now()}`
    };

    const order = await razorpay.orders.create(options);

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      success: false,
      message: "Failed to create order"
    });

  }

});

/* =========================
   VERIFY PAYMENT
========================= */

app.post("/verify-payment", async (req, res) => {

  try {

    const {

      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,

      customer,
      cart,
      amount

    } = req.body;

    // VERIFY SIGNATURE

    const generatedSignature =
      crypto
      .createHmac(
        "sha256",
        process.env.RAZORPAY_KEY_SECRET
      )
      .update(
        razorpay_order_id + "|" +
        razorpay_payment_id
      )
      .digest("hex");

    if (generatedSignature !== razorpay_signature) {

      return res.status(400).json({
        success: false,
        message: "Payment verification failed"
      });

    }

    // SAVE ORDER

    const { error: dbError } = await supabase
      .from("orders")
      .insert([
        {
          customer_name: customer.name,
          mobile: customer.mobile,
          address: customer.location,

          items: cart,

          payment_status: "paid",

          payment_id: razorpay_payment_id,

          razorpay_order_id,

          amount_paid: amount
        }
      ]);

    if (dbError) {

      console.log(dbError);

      return res.status(500).json({
        success: false,
        message: "Database insert failed"
      });

    }

    // CALCULATE TOTAL

    let total = 0;

    cart.forEach(item => {
      total += item.price * item.qty;
    });

    // WHATSAPP MESSAGE

    const whatsappMessage = `
🍔 NEW PAID FOOD ORDER

👤 Customer: ${customer.name}
📞 Mobile: ${customer.mobile}

📍 Address:
${customer.location}

🛒 ITEMS:
${cart.map(item =>
  `• ${item.name} x${item.qty} = ₹${item.price * item.qty}`
).join("\n")}

💰 TOTAL PAID: ₹${total}

✅ PAYMENT STATUS: PAID
`;

    try {

      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: process.env.OWNER_WHATSAPP_NUMBER,
        body: whatsappMessage
      });

    } catch (err) {

      console.log("WhatsApp error:", err.message);

    }

    res.json({
      success: true,
      message: "Payment verified"
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      success: false,
      message: "Server error"
    });

  }

});

/* =========================
   WHATSAPP NOTIFICATION
========================= */
const whatsappMessage = `
🍔 NEW FOOD ORDER

👤 Customer: ${order.customer.name}
📞 Mobile: ${order.customer.mobile}

📍 Address:
${order.customer.location}

🛒 ITEMS:
${order.cart.map(item =>
  `• ${item.name} x${item.qty} = ₹${item.price * item.qty}`
).join("\n")}

💰 TOTAL: ₹${total}
`;

try {

  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: process.env.OWNER_WHATSAPP_NUMBER,
    body: whatsappMessage
  });

  console.log("WhatsApp notification sent");

} catch (whatsappError) {

  console.log(
    "WhatsApp error:",
    whatsappError.message
  );

}
    res.json({
      success: true,
      message: "Order saved successfully"
    });

  } catch (error) {
    console.log(error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

/* =========================
   GITHUB TEST ROUTE (ADD THIS)
========================= */
app.get("/github-test", async (req, res) => {
  try {
    const response = await axios.get(
      "https://api.github.com/user",
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json"
        }
      }
    );

    res.json({
      ok: true,
      login: response.data.login
    });

  } catch (err) {
    res.json({
      ok: false,
      error: err.response?.data || err.message
    });
  }
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
