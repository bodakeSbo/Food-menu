const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

app.use(cors());
app.use(express.json());

const GITHUB_TOKEN = "YOUR_GITHUB_TOKEN";
const OWNER = "YOUR_GITHUB_USERNAME";
const REPO = "YOUR_REPOSITORY_NAME";

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
      `https://api.github.com/repos/${bodakeSbo}/${Food-menu}/issues`,
      {
        title: issueTitle,
        body: issueBody
      },
      {
        headers: {
          Authorization: `token ${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}`,
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
