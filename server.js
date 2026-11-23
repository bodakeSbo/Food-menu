const twilio = require("twilio");
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const stripe = require("stripe")(
  process.env.STRIPE_SECRET_KEY
);

const app = express();

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

const GITHUB_TOKEN =
  process.env.GITHUB_TOKEN;

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
   SERVER PRODUCT CATALOG
========================= */

/*
 * These are the official prices.
 *
 * The backend uses these prices for:
 * 1. Calculating the total
 * 2. Saving the order in Supabase
 * 3. Creating the Stripe Checkout payment
 *
 * Prices received from the web browser are ignored.
 */

const PRODUCTS = {
  Burger: {
    name: "Burger",
    price: 199
  },

  Pizza: {
    name: "Pizza",
    price: 299
  },

  Pasta: {
    name: "Pasta",
    price: 249
  }
};

/* =========================
   GENERAL MIDDLEWARE
========================= */

app.use(cors());

/*
 * The Stripe webhook must be registered
 * before app.use(express.json()).
 *
 * Stripe needs the original raw request
 * body to verify the webhook signature.
 */

/* =========================
   STRIPE WEBHOOK
========================= */

app.post(
  "/stripe-webhook",

  express.raw({
    type: "application/json"
  }),

  async (req, res) => {

    const signature =
      req.headers["stripe-signature"];

    let event;

    try {

      event =
        stripe.webhooks.constructEvent(
          req.body,
          signature,
          process.env.STRIPE_WEBHOOK_SECRET
        );

    } catch (error) {

      console.error(
        "Stripe webhook verification failed:",
        error.message
      );

      return res
        .status(400)
        .send(
          `Webhook error: ${error.message}`
        );
    }

    try {

      if (
        event.type ===
        "checkout.session.completed"
      ) {

        const session =
          event.data.object;

        if (
          session.payment_status === "paid"
        ) {

          await confirmPaidOrder(session);

        } else {

          console.log(
            `Stripe session ${session.id} completed, ` +
            `but payment status is ${session.payment_status}`
          );

        }

      }

      return res
        .status(200)
        .json({
          received: true
        });

    } catch (error) {

      console.error(
        "Stripe webhook processing failed:",
        error
      );

      return res
        .status(500)
        .json({
          received: false,
          message:
            "Webhook processing failed"
        });

    }

  }
);

/*
 * Normal JSON parsing starts only
 * after the Stripe webhook route.
 */

app.use(express.json());

/* =========================
   WHATSAPP FUNCTION
========================= */

async function sendWhatsAppNotification(
  order
) {

  const cart =
    Array.isArray(order.items)
      ? order.items
      : [];

  const itemsText =
    cart
      .map(item => {

        const itemTotal =
          Number(item.price) *
          Number(item.qty);

        return (
          `• ${item.name} x${item.qty}` +
          ` = ₹${itemTotal}`
        );

      })
      .join("\n");

  const whatsappMessage = `
🍔 NEW PAID FOOD ORDER

🧾 Order ID: ${order.id}

👤 Customer: ${order.customer_name}
📞 Mobile: ${order.mobile}

📍 Address:
${order.address}

🛒 ITEMS:
${itemsText}

💰 TOTAL: ₹${order.total_amount}
✅ PAYMENT: CONFIRMED
`;

  await client.messages.create({

    from:
      process.env.TWILIO_WHATSAPP_NUMBER,

    to:
      process.env.OWNER_WHATSAPP_NUMBER,

    body:
      whatsappMessage

  });

  console.log(
    `WhatsApp notification sent for order ${order.id}`
  );
}

/* =========================
   CONFIRM PAID ORDER
========================= */

async function confirmPaidOrder(session) {

  const orderId =
    session.metadata?.orderId;

  if (!orderId) {

    throw new Error(
      `No orderId found in Stripe session ${session.id}`
    );

  }

  const {
    data: existingOrder,
    error: lookupError
  } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (
    lookupError ||
    !existingOrder
  ) {

    throw new Error(
      `Order ${orderId} could not be found`
    );

  }

  /*
   * Stripe can send the same webhook
   * more than once.
   *
   * Do not confirm or notify the
   * same order twice.
   */

  if (
    existingOrder.payment_status ===
    "paid"
  ) {

    console.log(
      `Order ${orderId} was already confirmed`
    );

    return;

  }

  const expectedAmountInPaise =
    Math.round(
      Number(
        existingOrder.total_amount
      ) * 100
    );

  /*
   * Confirm that Stripe received
   * exactly the expected amount.
   */

  if (
    session.amount_total !==
    expectedAmountInPaise
  ) {

    throw new Error(
      `Payment mismatch for order ${orderId}. ` +
      `Expected ${expectedAmountInPaise}, ` +
      `received ${session.amount_total}`
    );

  }

  if (
    session.currency !== "inr"
  ) {

    throw new Error(
      `Unexpected payment currency: ` +
      `${session.currency}`
    );

  }

  const {
    data: confirmedOrder,
    error: updateError
  } = await supabase
    .from("orders")
    .update({

      payment_status:
        "paid",

      order_status:
        "confirmed",

      stripe_session_id:
        session.id,

      stripe_payment_intent_id:
        session.payment_intent,

      paid_at:
        new Date().toISOString()

    })
    .eq("id", orderId)
    .eq(
      "payment_status",
      "pending"
    )
    .select()
    .maybeSingle();

  if (updateError) {

    throw updateError;

  }

  /*
   * Another webhook may already have
   * completed this order.
   */

  if (!confirmedOrder) {

    console.log(
      `Order ${orderId} was already processed`
    );

    return;

  }

  /*
   * WhatsApp is sent only after the
   * verified payment updates the order.
   */

  try {

    await sendWhatsAppNotification(
      confirmedOrder
    );

  } catch (whatsappError) {

    console.error(
      "WhatsApp error:",
      whatsappError.message
    );

  }

  console.log(
    `Payment confirmed for order ${orderId}`
  );
}

/* =========================
   CREATE PAYMENT API
========================= */

app.post(
  "/order",
  async (req, res) => {

    try {

      const order =
        req.body;

      /*
       * Validate customer details.
       */

      if (
        !order.customer ||
        !order.customer.name ||
        !order.customer.mobile ||
        !order.customer.location
      ) {

        return res
          .status(400)
          .json({

            success: false,

            message:
              "Customer details are incomplete"

          });

      }

      /*
       * Validate the cart.
       */

      if (
        !Array.isArray(order.cart) ||
        order.cart.length === 0
      ) {

        return res
          .status(400)
          .json({

            success: false,

            message:
              "Cart is empty"

          });

      }

      /*
       * Build a secure cart.
       *
       * Prices from the frontend
       * are completely ignored.
       */

      const validatedCart = [];

      for (
        const item of order.cart
      ) {

        const product =
          PRODUCTS[item.name];

        const quantity =
          Number(item.qty);

        /*
         * Product must exist in the
         * server product catalogue.
         */

        if (!product) {

          return res
            .status(400)
            .json({

              success: false,

              message:
                `Invalid product: ${item.name}`

            });

        }

        /*
         * Quantity must be a whole
         * number between 1 and 20.
         */

        if (
          !Number.isInteger(quantity) ||
          quantity < 1 ||
          quantity > 20
        ) {

          return res
            .status(400)
            .json({

              success: false,

              message:
                `Invalid quantity for ${item.name}`

            });

        }

        validatedCart.push({

          name:
            product.name,

          price:
            product.price,

          qty:
            quantity

        });

      }

      /*
       * Calculate the total using
       * server-controlled prices.
       */

      const total =
        validatedCart.reduce(
          (sum, item) => {

            return (
              sum +
              item.price *
              item.qty
            );

          },
          0
        );

      /*
       * Create a pending order.
       *
       * The order is not confirmed
       * until Stripe sends a verified
       * successful-payment webhook.
       */

      const {
        data: pendingOrder,
        error: dbError
      } = await supabase
        .from("orders")
        .insert([
          {

            customer_name:
              order.customer.name,

            mobile:
              order.customer.mobile,

            address:
              order.customer.location,

            /*
             * Store server-validated
             * product prices.
             */
            items:
              validatedCart,

            total_amount:
              total,

            payment_status:
              "pending",

            order_status:
              "awaiting_payment"

          }
        ])
        .select()
        .single();

      if (dbError) {

        console.error(
          "Supabase error:",
          dbError
        );

        return res
          .status(500)
          .json({

            success: false,

            message:
              "Database insert failed"

          });

      }

      /*
       * Create Stripe Checkout using
       * server-controlled prices.
       *
       * INR uses paise:
       * ₹199 becomes 19900 paise.
       */

      const checkoutSession =
        await stripe
          .checkout
          .sessions
          .create({

            mode:
              "payment",

            payment_method_types:
              ["card"],

            line_items:
              validatedCart.map(
                item => ({

                  price_data: {

                    currency:
                      "inr",

                    product_data: {

                      name:
                        item.name

                    },

                    unit_amount:
                      Math.round(
                        item.price * 100
                      )

                  },

                  quantity:
                    item.qty

                })
              ),

            metadata: {

              orderId:
                String(
                  pendingOrder.id
                )

            },

            success_url:
              `${process.env.FRONTEND_URL}` +
              `?payment=success` +
              `&session_id={CHECKOUT_SESSION_ID}`,

            cancel_url:
              `${process.env.FRONTEND_URL}` +
              `?payment=cancelled`

          });

      /*
       * Save the Stripe session ID
       * on the pending order.
       */

      const {
        error: sessionUpdateError
      } = await supabase
        .from("orders")
        .update({

          stripe_session_id:
            checkoutSession.id

        })
        .eq(
          "id",
          pendingOrder.id
        );

      if (sessionUpdateError) {

        console.error(
          "Unable to save Stripe session ID:",
          sessionUpdateError
        );

      }

      return res
        .status(200)
        .json({

          success:
            true,

          message:
            "Payment session created",

          checkoutUrl:
            checkoutSession.url

        });

    } catch (error) {

      console.error(
        "Order/payment error:",
        error.raw?.message ||
        error.response?.data ||
        error.message
      );

      return res
        .status(500)
        .json({

          success: false,

          message:
            "Unable to start payment"

        });

    }

  }
);

/* =========================
   GITHUB TEST ROUTE
========================= */

app.get(
  "/github-test",
  async (req, res) => {

    try {

      const response =
        await axios.get(
          "https://api.github.com/user",
          {

            headers: {

              Authorization:
                `Bearer ${GITHUB_TOKEN}`,

              Accept:
                "application/vnd.github+json"

            }

          }
        );

      return res.json({

        ok:
          true,

        login:
          response.data.login

      });

    } catch (error) {

      return res.json({

        ok:
          false,

        error:
          error.response?.data ||
          error.message

      });

    }

  }
);

/* =========================
   HEALTH CHECK
========================= */

app.get(
  "/",
  (req, res) => {

    res.json({

      ok:
        true,

      service:
        "Food Menu Backend"

    });

  }
);

/* =========================
   START SERVER
========================= */

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  () => {

    console.log(
      `Server running on port ${PORT}`
    );

  }
);
