// ============================================================================
// Serveur d'inscription avec paiement Stripe
// ----------------------------------------------------------------------------
// Ce serveur :
//   1. Sert une page web avec un bouton "Payer".
//   2. Quand quelqu'un clique, crée une session de paiement Stripe (Checkout).
//   3. Stripe encaisse la carte de la personne, PUIS reverse l'argent
//      automatiquement (par virement) sur le compte bancaire configuré
//      dans le compte Stripe — selon le calendrier de virement de Stripe
//      (généralement tous les jours ou toutes les semaines, avec un délai
//      de quelques jours pour le tout premier virement). L'argent ne part
//      JAMAIS "directement" en un clic vers un IBAN : il transite toujours
//      par Stripe, qui gère la conformité, la lutte anti-fraude, etc.
//   4. Reçoit une notification (webhook) de Stripe quand le paiement est
//      confirmé, pour marquer l'inscription comme payée dans une vraie
//      application (ici on se contente de l'afficher dans les logs).
// ============================================================================

require('dotenv').config();
const https = require('https');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  PRICE_EUR,
  PRODUCT_NAME,
  DOMAIN,
  PORT,
  PATRO_SITE_URL,
  PATRO_WEBHOOK_SECRET,
} = process.env;

if (!STRIPE_SECRET_KEY) {
  console.error(
    '\n❌ STRIPE_SECRET_KEY manquant. Copie .env.example vers .env et renseigne ta clé secrète Stripe (sk_test_... ou sk_live_...).\n'
  );
  process.exit(1);
}

// Sur certains hebergeurs (ex: Render), le client HTTP par defaut de la
// librairie Stripe (base sur fetch/HTTP2) echoue systematiquement a se
// connecter ("StripeConnectionError" sans cause precise), meme apres
// plusieurs tentatives. On force donc le client HTTP "classique" (module
// Node natif https), plus compatible avec ce genre d'environnement.
// Meme avec ce client "classique", certains hebergeurs (dont Render, en
// tout cas sur certaines instances/regions) resolvent api.stripe.com en
// IPv6 par defaut, alors que leur sortie reseau IPv6 est cassee ou trop
// lente : la connexion tente IPv6, echoue en silence, puis abandonne sans
// jamais retomber correctement sur IPv4, ce qui remonte comme
// "StripeConnectionError" sans cause precise. On force donc explicitement
// l'IPv4 sur l'agent HTTPS utilise par Stripe pour contourner ce cas.
// IMPORTANT : l'agent doit etre passe EN PARAMETRE de
// createNodeHttpClient() et non via l'option separee "httpAgent" - cette
// derniere est ignoree des qu'un "httpClient" est fourni explicitement
// (NodeHttpClient cree alors son propre agent HTTPS par defaut en interne
// et ne regarde jamais l'option "httpAgent" du tout).
const stripeHttpsAgent = new https.Agent({ family: 4, keepAlive: true });
const stripe = Stripe(STRIPE_SECRET_KEY, {
  maxNetworkRetries: 3,
  timeout: 20000,
  httpClient: Stripe.createNodeHttpClient(stripeHttpsAgent),
});
const app = express();

// Necessaire derriere un reverse proxy (Render, etc.) pour que req.ip
// reflete la vraie IP du visiteur (sinon tout le monde seme confondu avec
// l'IP du proxy, ce qui casse le rate-limiting ci-dessous).
app.set('trust proxy', 1);

// En-tetes de securite HTTP (gratuit, via le paquet "helmet"). Le
// Content-Security-Policy par defaut de helmet bloquerait le <script> et le
// <style> inline de public/index.html : on autorise donc explicitement
// 'unsafe-inline' pour script/style plutot que de tout reecrire avec des
// nonces, tout en gardant les protections utiles (pas d'iframe externe, pas
// de <object>, pas de changement de <base>, formulaires vers ce site
// uniquement).
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  })
);

// Limite generale (anti-abus/anti-DoS basique) sur toutes les routes, assez
// large pour ne jamais gener un visiteur normal.
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Limite plus stricte specifiquement sur la creation de sessions de
// paiement/don (evite qu'un script puisse spammer la creation de sessions
// Stripe, qui a un cout et pourrait servir a du carding/fraude).
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessaie dans quelques minutes.' },
});

const port = PORT || 4242;
const domain = DOMAIN || `http://localhost:${port}`;
const priceInCents = Math.round(parseFloat(PRICE_EUR || '25') * 100);
const productName = PRODUCT_NAME || "Frais d'inscription";

// ----------------------------------------------------------------------------
// Determine le "type" de paiement a partir du prefixe de la reference,
// exactement comme mark_paid.php cote PHP (voir ce fichier), pour savoir
// quel tarif aller chercher.
// ----------------------------------------------------------------------------
function priceTypeForRef(ref) {
  if (!ref) return 'inscription';
  if (ref.startsWith('camp-')) return 'camp';
  if (ref.startsWith('animateur-camp-')) return 'animateur_camp';
  if (ref.startsWith('animateur-')) return 'animateur';
  return 'inscription';
}

// ----------------------------------------------------------------------------
// Va chercher, cote site Patro (PHP), le prix actuel pour ce type de
// paiement (modifiable par un admin - voir admin.php, onglet Tarifs).
// Si le site est injoignable (ou PATRO_SITE_URL non configure, ex: tests
// locaux isoles), on retombe sur le prix fixe de .env pour ne pas bloquer
// le paiement.
// ----------------------------------------------------------------------------
async function getPriceForRef(ref) {
  const type = priceTypeForRef(ref);
  if (PATRO_SITE_URL && PATRO_WEBHOOK_SECRET) {
    try {
      const r = await fetch(`${PATRO_SITE_URL}/get_price.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, secret: PATRO_WEBHOOK_SECRET }),
      });
      if (r.ok) {
        const data = await r.json();
        if (typeof data.price_eur === 'number' && data.price_eur > 0) {
          return {
            priceInCents: Math.round(data.price_eur * 100),
            productName: data.product_name || productName,
          };
        }
      } else {
        console.error('⚠️  Le site Patro a refusé la demande de tarif :', r.status);
      }
    } catch (err) {
      console.error('⚠️  Impossible de récupérer le tarif depuis le site Patro, utilisation du tarif par défaut :', err.message);
    }
  }
  // Repli : tarif fixe configure dans .env.
  return { priceInCents, productName };
}

// ----------------------------------------------------------------------------
// Previent le site Patro (PHP) qu'une inscription a ete payee. Utilise a la
// fois par le webhook (mode production/Stripe CLI) et par la route
// /session-status ci-dessous (filet de securite en local sans Stripe CLI).
// ----------------------------------------------------------------------------
async function notifyPatroSite(inscriptionId) {
  if (!inscriptionId || !PATRO_SITE_URL || !PATRO_WEBHOOK_SECRET) {
    return;
  }
  try {
    const r = await fetch(`${PATRO_SITE_URL}/mark_paid.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: inscriptionId, secret: PATRO_WEBHOOK_SECRET }),
    });
    if (!r.ok) {
      console.error('⚠️  Le site Patro a refusé la mise à jour du paiement :', r.status);
    } else {
      console.log(`   Inscription #${inscriptionId} marquée payée sur le site Patro.`);
    }
  } catch (err) {
    console.error('⚠️  Impossible de contacter le site Patro :', err.message);
  }
}

// ----------------------------------------------------------------------------
// IMPORTANT : la route webhook doit lire le corps BRUT (pas du JSON déjà
// parsé), sinon la vérification de signature Stripe échoue. On la déclare
// donc AVANT express.json().
// ----------------------------------------------------------------------------
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    let event = req.body;

    // En production, on vérifie que l'événement vient bien de Stripe.
    if (STRIPE_WEBHOOK_SECRET) {
      const signature = req.headers['stripe-signature'];
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          signature,
          STRIPE_WEBHOOK_SECRET
        );
      } catch (err) {
        console.error('⚠️  Signature webhook invalide :', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }
    } else {
      // Sans secret configuré (ex: tests locaux sans Stripe CLI), on parse
      // simplement le JSON sans vérification. Ne PAS faire ça en production.
      try {
        event = JSON.parse(req.body);
      } catch (err) {
        return res.status(400).send('JSON invalide');
      }
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        console.log('✅ Paiement confirmé pour la session :', session.id);
        console.log('   Email du payeur :', session.customer_details?.email);
        console.log('   Montant payé :', session.amount_total / 100, session.currency.toUpperCase());

        // Si la session porte la reference d'une inscription du site Patro
        // (voir /creer-session-paiement ci-dessous), on previent le site
        // pour qu'il marque cette inscription comme payee.
        notifyPatroSite(session.client_reference_id);
        break;
      }
      case 'payout.paid': {
        const payout = event.data.object;
        console.log('💸 Virement effectué vers le compte bancaire :', payout.amount / 100, payout.currency.toUpperCase());
        break;
      }
      default:
        // On ignore les autres types d'événements dans cet exemple.
        break;
    }

    res.json({ received: true });
  }
);

// Le reste des routes utilise du JSON classique.
app.use(express.json());
app.use(express.static('public'));

// Petite route pour que la page HTML affiche le bon prix et le bon nom
// sans avoir à les recopier en dur dans le HTML. Le prix depend du type de
// paiement (voir ?ref=... dans l'URL de la page), determine cote site Patro.
app.get('/config', async (req, res) => {
  const ref = typeof req.query.ref === 'string' ? req.query.ref : undefined;
  const { priceInCents: cents, productName: name } = await getPriceForRef(ref);
  res.json({
    prixEuros: cents / 100,
    nomProduit: name,
    // Utilise par succes.html pour rediriger vers le site Patro (PHP) une
    // fois le paiement confirme, au lieu de rester sur ce serveur de
    // paiement (voir PATRO_SITE_URL dans .env).
    patroSiteUrl: PATRO_SITE_URL || null,
  });
});

// ----------------------------------------------------------------------------
// Crée une session de paiement Stripe Checkout et renvoie l'URL vers
// laquelle rediriger la personne pour qu'elle paie.
// ----------------------------------------------------------------------------
app.post('/creer-session-paiement', paymentLimiter, async (req, res) => {
  try {
    // "ref" est optionnel : c'est l'identifiant de l'inscription sur le
    // site Patro, transmis pour que le webhook puisse la marquer payee.
    const ref = typeof req.body?.ref === 'string' ? req.body.ref.slice(0, 100) : undefined;
    // Le prix est toujours determine ici, cote serveur, a partir du type
    // deduit de la reference - jamais a partir d'une valeur envoyee par le
    // navigateur, pour ne pas pouvoir etre manipule.
    const { priceInCents: cents, productName: name } = await getPriceForRef(ref);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      client_reference_id: ref,
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: {
              name,
            },
            unit_amount: cents,
          },
          quantity: 1,
        },
      ],
      success_url: `${domain}/succes.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${domain}/annulation.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Erreur création session Stripe :', err.message);
    console.error('   type:', err.type, '| code:', err.code, '| cause:', err.cause?.code || err.cause?.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// Cree une session de paiement Stripe Checkout pour un DON (montant libre
// choisi par la personne, independant du prix d'inscription configure).
// ----------------------------------------------------------------------------
app.post('/creer-session-don', paymentLimiter, async (req, res) => {
  try {
    const amountEur = parseFloat(req.body?.amount);
    if (!Number.isFinite(amountEur) || amountEur < 1 || amountEur > 5000) {
      return res.status(400).json({ error: 'Montant invalide (entre 1 et 5000 euros).' });
    }
    const amountCents = Math.round(amountEur * 100);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: {
              name: 'Don au Patro',
            },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
      success_url: `${domain}/don-succes.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${domain}/annulation.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Erreur création session don Stripe :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// Filet de securite pour le developpement local (sans Stripe CLI) : la page
// succes.html appelle cette route avec le session_id recu de Stripe apres
// paiement. On revérifie DIRECTEMENT aupres de Stripe (jamais en faisant
// confiance a l'URL telle quelle) que le paiement est bien confirme avant
// de prevenir le site Patro. En production, le webhook fait deja ce travail
// independamment ; cette route est redondante mais sans danger.
// ----------------------------------------------------------------------------
app.get('/session-status', async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    if (!sessionId) {
      return res.status(400).json({ error: 'session_id manquant' });
    }
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status === 'paid') {
      await notifyPatroSite(session.client_reference_id);
    }
    res.json({ payment_status: session.payment_status });
  } catch (err) {
    console.error('Erreur verification session :', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`\n🚀 Serveur lancé sur ${domain}`);
  console.log(`   Prix configuré : ${(priceInCents / 100).toFixed(2)} € — "${productName}"`);
  if (!STRIPE_WEBHOOK_SECRET) {
    console.log('   ⚠️  Aucun STRIPE_WEBHOOK_SECRET configuré (voir README pour le mode test avec Stripe CLI).');
  }
});
