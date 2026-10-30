// Generates the VAPID key pair used to sign Web Push messages.
//   npm run vapid
// Public key  → VITE_VAPID_PUBLIC_KEY (frontend) AND VAPID_PUBLIC_KEY (function secret)
// Private key → VAPID_PRIVATE_KEY (function secret ONLY — never in the frontend)
import webpush from 'web-push';
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
