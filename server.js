const twilio = require("twilio");
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

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

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

/* =========================
   TWILIO SETUP
========================= */

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/* =========================
   SERVER PRODUCT CATALOG
========================= */

/*
 * IMPORTANT:
 * These are the official prices.
 * Prices coming from index.html are ignored.
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


/* =========================
   STRIPE WEBHOOK

   MUST remain BEFORE
   express.json()
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
            `Session ${session.id} completed ` +
            `but payment status is ${session.payment_status}`
          );

        }

      }


      return res.status(200).json({
        received: true
      });


    } catch (error) {

      console.error(
        "Webhook processing failed:",
        error
      );

      return res.status(500).json({
        received: false,
        message: "Webhook processing failed"
      });

    }

  }
);


/*
 * Normal application JSON parsing
 * starts AFTER Stripe webhook.
 */

app.use(express.json());


/* =========================
   WHATSAPP NOTIFICATION
========================= */

async function sendWhatsAppNotification(order) {

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
   * Prevent duplicate processing.
   */

  if (
    existingOrder.payment_status === "paid"
  ) {

    console.log(
      `Order ${orderId} already confirmed`
    );

    return;

  }


  const expectedAmountInPaise =
    Math.round(
      Number(existingOrder.total_amount) * 100
    );


  /*
   * Verify Stripe actually received
   * the expected amount.
   */

  if (
    session.amount_total !==
    expectedAmountInPaise
  ) {

    throw new Error(
      `Payment amount mismatch for order ${orderId}`
    );

  }


  if (
    session.currency !== "inr"
  ) {

    throw new Error(
      `Unexpected currency: ${session.currency}`
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
    .eq(
      "id",
      orderId
    )
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
   * Another webhook might already
   * have processed this payment.
   */

  if (!confirmedOrder) {

    console.log(
      `Order ${orderId} already processed`
    );

    return;

  }


  /*
   * Send WhatsApp only AFTER
   * payment confirmation.
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
   CREATE PAYMENT
========================= */

app.post(
  "/order",
  async (req, res) => {

    try {

      const order =
        req.body;


      /*
       * CUSTOMER VALIDATION
       */

      if (
        !order.customer ||
        !order.customer.name ||
        !order.customer.mobile ||
        !order.customer.location
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Customer details are incomplete"

        });

      }


      /*
       * CART VALIDATION
       */

      if (
        !Array.isArray(order.cart) ||
        order.cart.length === 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Cart is empty"

        });

      }


      /*
       * SERVER VALIDATED CART
       *
       * Browser prices are ignored.
       */

      const validatedCart = [];


      for (
        const item of order.cart
      ) {

        const product =
          PRODUCTS[item.name];

        const quantity =
          Number(item.qty);


        if (!product) {

          return res.status(400).json({

            success: false,

            message:
              `Invalid product: ${item.name}`

          });

        }


        if (
          !Number.isInteger(quantity) ||
          quantity < 1 ||
          quantity > 20
        ) {

          return res.status(400).json({

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
       * CALCULATE TOTAL USING
       * SERVER PRICES
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
       * CREATE PENDING ORDER
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

        return res.status(500).json({

          success: false,

          message:
            "Database insert failed"

        });

      }


      /*
       * CREATE STRIPE CHECKOUT
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
       * SAVE STRIPE SESSION
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
          "Unable to save Stripe session:",
          sessionUpdateError
        );

      }


      return res.status(200).json({

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


      return res.status(500).json({

    
