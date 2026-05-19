require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
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
   ORDER API
========================= */
app.post("/order", async (req, res) => {
  try {
    const order = req.body;

    let total = 0;
    order.cart.forEach(item => {
      total += item.price * item.qty;
    });

    const { error: dbError } = await supabase
      .from("orders")
      .insert([
        {
          customer_name: order.customer.name,
          mobile: order.customer.mobile,
          address: order.customer.location,
          items: order.cart
        }
      ]);

    if (dbError) {
      console.log("Supabase error:", dbError);
      return res.status(500).json({
        success: false,
        message: "Database insert failed"
      });
    }

    if (GITHUB_TOKEN) {
      const issueTitle = `New Order from ${order.customer.name}`;

      const issueBody = `
Customer Name: ${order.customer.name}
Mobile: ${order.customer.mobile}
Address: ${order.customer.location}

Order Items:
${order.cart.map(item =>
  `- ${item.name} x${item.qty} = ₹${item.price * item.qty}`
).join("\n")}

Total: ₹${total}
`;

      try {
        await axios.post(
          `https://api.github.com/repos/${OWNER}/${REPO}/issues`,
          {
            title: issueTitle,
            body: issueBody
          },
          {
            headers: {
              Authorization: `Bearer ${GITHUB_TOKEN}`,
              Accept: "application/vnd.github+json"
            }
          }
        );
      } catch (githubError) {
        console.log("GitHub error:", githubError.response?.data || githubError.message);
      }
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
