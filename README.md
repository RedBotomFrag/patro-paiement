# Site d'inscription avec paiement (Stripe)

Ce projet contient un mini site web avec un bouton **"Payer"**. Quand une
personne clique dessus, elle est redirigée vers une page de paiement Stripe
sécurisée (Checkout), paie par carte, puis revient sur une page de
confirmation.

## ⚠️ Point important à comprendre avant tout

L'argent ne part **jamais directement** vers ton numéro de compte (IBAN) au
moment du clic. Le circuit réel est toujours :

```
Client clique "Payer" → paie par carte → l'argent arrive chez Stripe
    → Stripe le reverse ensuite automatiquement sur TON compte bancaire
      (virement appelé "payout"), selon un calendrier (souvent tous les
      jours ou toutes les semaines).
```

Pourquoi ça marche comme ça (et pas de virement instantané direct) :
- Stripe doit vérifier l'identité du vendeur (toi) et du paiement pour
  éviter la fraude, avant de reverser l'argent.
- Le **premier virement** prend généralement **7 à 14 jours** après ton
  inscription sur Stripe ; les suivants sont ensuite quotidiens ou
  hebdomadaires selon ton pays et tes réglages.
- C'est la norme pour Stripe, PayPal, et tout système de paiement en ligne
  sérieux — personne ne fait de vrai virement bancaire instantané à chaque
  clic, pour des raisons de sécurité et de réglementation bancaire.

Tu peux régler la fréquence des virements (quotidien / hebdomadaire /
manuel) dans ton Dashboard Stripe, une fois le compte créé et vérifié.

## Étape 1 — Créer ton compte Stripe

1. Va sur https://dashboard.stripe.com/register et crée un compte.
2. Dans **Paramètres > Comptes bancaires et cartes**, ajoute ton IBAN
   (le compte sur lequel tu veux recevoir l'argent).
3. Dans **Développeurs > Clés API**, récupère ta **clé secrète** :
   - `sk_test_...` pour tester sans vrai argent (recommandé pour commencer).
   - `sk_live_...` une fois que ton compte est activé, pour le vrai paiement.

## Étape 2 — Installer le projet

```bash
npm install
cp .env.example .env
```

Ouvre `.env` et renseigne :
- `STRIPE_SECRET_KEY` → ta clé secrète Stripe (`sk_test_...` pour commencer).
- `PRICE_EUR` → le montant de l'inscription (ex: `25`).
- `PRODUCT_NAME` → le nom affiché (ex: `Inscription au club`).

## Étape 3 — Tester en local

```bash
npm start
```

Ouvre http://localhost:4242 dans ton navigateur. Clique sur "Payer", tu
arrives sur la page Stripe. En mode test, utilise une carte de test comme :

```
Numéro : 4242 4242 4242 4242
Date   : n'importe quelle date future
CVC    : n'importe quel code à 3 chiffres
```

Le paiement passera "pour de faux" (aucun vrai argent ne bouge), ce qui te
permet de vérifier que tout le flux fonctionne avant de passer en réel.

### (Optionnel mais recommandé) Tester les notifications de paiement

Pour recevoir les webhooks Stripe en local, installe la
[Stripe CLI](https://stripe.com/docs/stripe-cli) puis lance :

```bash
stripe listen --forward-to localhost:4242/webhook
```

Elle t'affiche un `whsec_...` à mettre dans `STRIPE_WEBHOOK_SECRET` (`.env`).
Redémarre le serveur ensuite.

## Étape 4 — Passer en paiement réel

1. Termine l'activation de ton compte Stripe (identité, infos légales).
2. Remplace `STRIPE_SECRET_KEY` par ta clé `sk_live_...`.
3. Dans le Dashboard Stripe (mode Live), va dans **Développeurs > Webhooks**,
   ajoute un endpoint pointant vers `https://ton-site.exemple.com/webhook`,
   coche l'événement `checkout.session.completed`, et copie le secret de
   signature dans `STRIPE_WEBHOOK_SECRET`.
4. Mets à jour `DOMAIN` dans `.env` avec ton vrai nom de domaine.
5. Déploie le projet (Render, Railway, Fly.io, un VPS, etc. — n'importe quel
   hébergeur capable de faire tourner du Node.js).

À partir de là, chaque paiement réel sera automatiquement viré sur ton
compte bancaire par Stripe, selon le calendrier de virement configuré dans
ton Dashboard (**Paramètres > Virements bancaires**).

## Structure du projet

```
inscription-paiement/
├── server.js              → serveur Express + logique Stripe
├── package.json
├── .env.example            → à copier vers .env
├── public/
│   ├── index.html          → page avec le bouton "Payer"
│   ├── succes.html          → page affichée après un paiement réussi
│   └── annulation.html      → page affichée si la personne annule
└── README.md
```

## Sécurité — à ne jamais faire

- Ne mets jamais ta clé secrète (`sk_...`) dans du code envoyé au
  navigateur (HTML/JS public) : elle doit rester uniquement côté serveur
  (`server.js`, fichier `.env`), sinon n'importe qui pourrait l'utiliser
  pour créer des paiements en ton nom.
- Ne commite jamais le fichier `.env` dans Git (déjà exclu via
  `.gitignore`).
