# GBA Insieme

Emulatore GBA nel browser. Tu giochi, gli amici guardano in diretta e possono prendere i comandi.

## Provarlo sul tuo PC
Fai doppio clic su `PROVA IN LOCALE.bat`: si apre il browser.
- Scegli il gioco (.gba) e parte. Accanto compare il codice della stanza.
- Per fare da "amico" apri una seconda finestra di Chrome, vai sullo stesso indirizzo e inserisci il codice.

## Metterlo online gratis (GitHub Pages)
1. Su github.com crea un nuovo repository pubblico, per esempio `gba-insieme`.
2. Carica `index.html`, `app.js` e `style.css` (pulsante "Add file" → "Upload files").
3. Vai su Settings → Pages → Branch: `main`, cartella `/ (root)` → Save.
4. Dopo un minuto il sito è su `https://TUONOME.github.io/gba-insieme/`.

**Non caricare mai i file dei giochi nel repository.** Ognuno sceglie il proprio dal suo PC.

## Tasti
Frecce = croce · Z = A · X = B · Q = L · E = R · Invio = Start · V = Select.
L'amico può usare anche un gamepad o i tasti sullo schermo (da telefono).

## Come funziona, in breve
- Emulatore: EmulatorJS (mGBA), caricato da cdn.emulatorjs.org.
- Video, audio e comandi viaggiano direttamente tra i browser (WebRTC, tramite PeerJS).
