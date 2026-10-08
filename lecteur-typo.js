/* Lecteur Typo Cao — habillage Video.js (gros bouton Lire, ±10 s, vitesse, image dans l'image,
   plein écran, logo TYPO CAO) aux couleurs de l'atelier. Chargé à la demande ; si Video.js
   n'est pas disponible, la vidéo garde ses commandes natives. */
(function (global) {
  const VJS = "https://cdnjs.cloudflare.com/ajax/libs/video.js/8.10.0/";
  const CSS = `
.vjs-typo{font-family:Outfit,system-ui,sans-serif;border-radius:12px;overflow:hidden;background:#000}
.vjs-typo .vjs-big-play-button{width:76px;height:76px;line-height:72px;border-radius:50%;background:rgba(43,34,24,.72);border:2px solid #d9b25e;font-size:2.6em;margin-top:-38px;margin-left:-38px;transition:background .2s,border-color .2s}
.vjs-typo:hover .vjs-big-play-button,.vjs-typo .vjs-big-play-button:focus{background:#a87c3f;border-color:#fff}
.vjs-typo .vjs-control-bar{background:linear-gradient(180deg,rgba(43,34,24,0),rgba(43,34,24,.88));height:3.6em;padding-top:.3em}
.vjs-typo .vjs-play-progress,.vjs-typo .vjs-volume-level{background:#d9b25e}
.vjs-typo .vjs-play-progress::before{color:#fff}
.vjs-typo .vjs-slider{background:rgba(255,255,255,.22)}
.vjs-typo .vjs-load-progress div{background:rgba(255,255,255,.35)}
.vjs-typo .vjs-time-tooltip,.vjs-typo .vjs-mouse-display .vjs-time-tooltip,.vjs-typo .vjs-volume-tooltip{background:#a87c3f;color:#fff;font-family:inherit}
.vjs-typo .vjs-menu-button-popup .vjs-menu .vjs-menu-content{background:rgba(43,34,24,.95)}
.vjs-typo .vjs-menu li.vjs-selected,.vjs-typo .vjs-menu li.vjs-selected:focus,.vjs-typo .vjs-menu li.vjs-selected:hover{background:#a87c3f;color:#fff}
.vjs-typo .vjs-seek-btn .vjs-icon-placeholder::before{content:attr(data-txt);font-size:.72em;font-weight:600;letter-spacing:0;line-height:4.2em;font-family:Outfit,system-ui,sans-serif}
.vjs-typo .vjs-logo{width:auto;padding:0 12px 0 8px;font-family:Fraunces,Georgia,serif;letter-spacing:.14em;font-size:.95em;color:#fdf9f1;text-decoration:none;display:flex;align-items:center;white-space:nowrap}
.vjs-typo .vjs-logo b{color:#d9b25e;font-weight:600;margin-left:.3em}
.vjs-typo .vjs-logo:hover b{color:#fff}
.vjs-typo .vjs-poster{background-size:cover}
.vjs-typo .vjs-remaining-time{display:none}
.vjs-typo .vjs-current-time,.vjs-typo .vjs-duration,.vjs-typo .vjs-time-divider{display:block;padding:0 .3em}
`;
  const FR = {
    "Play": "Lire", "Pause": "Pause", "Replay": "Revoir", "Mute": "Couper le son", "Unmute": "Activer le son",
    "Fullscreen": "Plein écran", "Exit Fullscreen": "Quitter le plein écran", "Non-Fullscreen": "Quitter le plein écran",
    "Picture-in-Picture": "Image dans l'image", "Exit Picture-in-Picture": "Quitter l'image dans l'image",
    "Playback Rate": "Vitesse de lecture", "Current Time": "Temps actuel", "Duration": "Durée",
    "Progress Bar": "Barre de progression", "Volume Level": "Volume", "Video Player": "Lecteur vidéo",
    "The media could not be loaded, either because the server or network failed or because the format is not supported.":
      "La vidéo n'a pas pu être chargée : vérifiez votre connexion, ou le format n'est pas pris en charge par ce navigateur.",
    "{1} is loading.": "{1} en cours de chargement.", "Loaded": "Chargé", "Progress": "Progression",
    "progress bar timing: currentTime={1} duration={2}": "{1} sur {2}"
  };

  let chargement = null;
  function chargerVideoJs() {
    if (global.videojs) return Promise.resolve(global.videojs);
    if (chargement) return chargement;
    chargement = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = VJS + "video-js.min.css";
      document.head.appendChild(css);
      const theme = document.createElement("style"); theme.textContent = CSS; document.head.appendChild(theme);
      const js = document.createElement("script");
      js.src = VJS + "video.min.js"; js.async = true;
      const t = setTimeout(() => reject(new Error("Video.js : délai dépassé")), 9000);
      js.onload = () => { clearTimeout(t); global.videojs ? resolve(global.videojs) : reject(new Error("Video.js absent")); };
      js.onerror = () => { clearTimeout(t); reject(new Error("Video.js : chargement impossible")); };
      document.head.appendChild(js);
    });
    return chargement;
  }

  function creerLecteur(el, options) {
    const videojs = global.videojs;
    const opts = Object.assign({ site: "./", poster: "", autoplay: false }, options || {});
    videojs.addLanguage("fr", FR);
    const Button = videojs.getComponent("Button");
    class Saut extends Button {
      constructor(player, o) {
        super(player, o);
        this.sec = o.sec;
        this.controlText((o.sec > 0 ? "Avancer" : "Reculer") + " de 10 secondes");
        this.addClass("vjs-seek-btn");
        const ph = this.el().querySelector(".vjs-icon-placeholder");
        if (ph) ph.setAttribute("data-txt", o.sec > 0 ? "+10" : "−10");
      }
      handleClick() {
        const p = this.player();
        const d = p.duration() || Number.POSITIVE_INFINITY;
        p.currentTime(Math.max(0, Math.min(d, p.currentTime() + this.sec)));
      }
    }
    const Component = videojs.getComponent("Component");
    class Logo extends Component {
      createEl() {
        return videojs.dom.createEl("a", {
          className: "vjs-control vjs-logo", href: opts.site, target: "_blank", rel: "noopener",
          title: "Typo Cao — composer la mienne", innerHTML: "TYPO <b>CAO</b>"
        });
      }
    }
    el.classList.add("video-js", "vjs-big-play-centered", "vjs-typo");
    const player = videojs(el, {
      language: "fr", fluid: true, playsinline: true, preload: "metadata", poster: opts.poster || undefined,
      playbackRates: [0.5, 1, 1.5, 2],
      controlBar: { pictureInPictureToggle: true, remainingTimeDisplay: false, currentTimeDisplay: true, durationDisplay: true, timeDivider: true },
      userActions: { hotkeys: true }
    });
    const bar = player.getChild("controlBar");
    const idx = bar.children().indexOf(bar.getChild("playToggle")) + 1;
    bar.addChild(new Saut(player, { sec: -10 }), {}, idx);
    bar.addChild(new Saut(player, { sec: 10 }), {}, idx + 1);
    bar.addChild(new Logo(player, {}));
    return player;
  }

  global.LecteurTypo = {
    charger: chargerVideoJs,
    creer: creerLecteur,
    /* Monte un lecteur sur un <video> ; renvoie une promesse (player ou null si Video.js indisponible). */
    monter(el, options) {
      return chargerVideoJs().then(() => creerLecteur(el, options)).catch(() => null);
    }
  };
})(window);
