require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

app.use(cors());
app.use(express.json());

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OWNER = "bodakeSbo";
const REPO = "Food-menu";

app.post("/order", async (req, res) => {

  try {

    const order = req.body;

    const issueTitle =
      `New Order from ${order.customer.name}`;

    const issueBody = `
Customer Name: ${order.customer.name}

Mobile: ${order.customer.mobile}

Address:
${order.customer.location}

Order Items:
${order.cart.map(item =>
`- ${item.name} x${item.qty} = ₹${item.price * item.qty}`
).join("\n")}
`;

    await axios.post(
  `https://api.github.com/repos/${OWNER}/${REPO}/issues`,
  {
    title: issueTitle,
    body: issueBody
  },
  {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json"
    }
  }
);

    res.json({
      success: true,
      message: "Order submitted successfully"
    });

  } catch (error) {

    console.log(error.response?.data || error.message);

    res.status(500).json({
      success: false,
      message: "Failed to create GitHub issue"
    });

  }

});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
