# 🎬 Editor Video Semplice

Un editor di foto e video che funziona **interamente nel browser**: niente da installare e nessun file viene caricato su internet.

## Come si avvia

Apri `index.html` con **Google Chrome** o **Microsoft Edge** (consigliati, esportano in MP4). Firefox funziona ma esporta in WebM.

In alternativa puoi pubblicarlo gratis con GitHub Pages (Settings → Pages → branch) e aprirlo da un link.

## Cosa sa fare

| Funzione | Dove |
|---|---|
| Importare foto e video | **＋ Foto / Video** oppure trascina i file nella finestra |
| Durata di ogni foto | Clicca la foto nella timeline → *Durata sullo schermo* |
| Dissolvenza tra le clip | *Dissolvenza dalla clip precedente* (0–3 s) |
| Foto animate con movimento leggero (come Movie Maker), sempre visibili per intero | *Animazione (movimento)*, oppure *Animazioni casuali* per tutte. Intensità regolabile in **⚙ Progetto** |
| Tagliare i video | Cursori *Inizio* / *Fine*, oppure *Inizio/Fine al cursore* |
| Dividere un video in due | *✂ Dividi al cursore* (poi puoi eliminare un pezzo) |
| Togliere l'audio di un video | *Rimuovi audio del video (muto)* |
| Una o più tracce musicali | **♪ Musica**: le tracce si mettono in fila. Trascinale nella timeline per spostarle; puoi tagliarle, regolare volume e dissolvenze |
| Riordinare le clip | Trascina le clip nella timeline |
| Formato (16:9, verticale 9:16, 1:1, 4:3), risoluzione, fps | **⚙ Progetto** |
| Esportare | **⬇ Esporta video** |

Scorciatoie: `spazio` play/pausa · `Canc` elimina la clip selezionata · `←` `→` sposta il cursore (con `Shift` di 1 secondo).

## Note sull'esportazione

- **Modalità veloce (predefinita):** il video viene calcolato fotogramma per fotogramma e codificato direttamente in MP4 (WebCodecs), senza aspettare la durata reale. Le foto sono molto più veloci del tempo reale; i video MP4/MOV vengono letti direttamente dal file. Serve Chrome o Edge aggiornati.
- **Modalità in tempo reale:** registra l'anteprima mentre scorre (un video di 3 minuti richiede circa 3 minuti). Resta disponibile come alternativa se la modalità veloce non funziona su un certo computer o con un certo file.
- I video in formati diversi da MP4/MOV (es. WebM) vengono comunque esportati, ma più lentamente.
- Il progetto non viene salvato: se chiudi la pagina devi ricominciare.

## File

- `index.html` – struttura della pagina
- `style.css` – grafica
- `app.js` – anteprima, timeline, animazioni, audio ed esportazione
- `lib/` – librerie esterne incluse: [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) (MIT) per creare il file MP4 e [mp4box.js](https://github.com/gpac/mp4box.js) (BSD-3) per leggere i video MP4/MOV
