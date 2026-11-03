(function () {
  "use strict";

  var STREAMS = [
    "https://stream.radiojar.com/8s5u5tpdtwzuv",
    "https://n10.radiojar.com/8s5u5tpdtwzuv",
    "https://n11.radiojar.com/8s5u5tpdtwzuv"
  ];

  var BITRATE_KBPS = 128;
  var BYTES_PER_SECOND = (BITRATE_KBPS * 1000) / 8;
  var RETRY_DELAY_MIN = 3000;
  var RETRY_DELAY_MAX = 15000;
  var OFFLINE_POLL = 4000;
  var HEARTBEAT_MS = 5000;
  var CONNECT_TIMEOUT = 15000;
  var STALL_TIMEOUT = 12000;
  var MAX_TICK_GAP = 90000;

  var KEY_VOLUME = "quran_volume";
  var KEY_BYTES = "quran_bytes_total";
  var KEY_DATE = "quran_bytes_date";

  var UA = navigator.userAgent || "";
  var IS_IOS =
    /iphone|ipad|ipod/i.test(UA) || (/Macintosh/i.test(UA) && navigator.maxTouchPoints > 1);
  var IS_ANDROID = /android/i.test(UA);

  var ICON_PLAY = '<path d="M8 5v14l11-7z"/>';
  var ICON_PAUSE = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
  var ICON_SPIN =
    '<path opacity=".3" d="M12 4a8 8 0 100 16A8 8 0 0012 4z"/>' +
    '<path d="M12 4a8 8 0 018 8h-2a6 6 0 00-6-6V4z">' +
    '<animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/>' +
    "</path>";

  var playBtn = document.getElementById("playBtn");
  var btnIcon = document.getElementById("btnIcon");
  var statusTxt = document.getElementById("statusTxt");
  var wave = document.getElementById("wave");
  var volSlider = document.getElementById("vol");
  var volVal = document.getElementById("volVal");
  var usageVal = document.getElementById("dataUsageVal");
  var usageDate = document.getElementById("dataUsageDate");
  var usageReset = document.getElementById("dataUsageReset");

  var audio = null;
  var srcActive = false;
  var wantPlay = false;
  var isPlaying = false;
  var streamIndex = 0;
  var retryCount = 0;
  var retryTimer = null;
  var watchdog = null;
  var heartbeat = null;
  var troubleAt = 0;
  var lastProgressAt = 0;

  function readStore(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function writeStore(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch (e) {}
  }

  function setStatus(kind, text) {
    statusTxt.className = kind ? "status " + kind : "status";
    statusTxt.textContent = text;
  }

  function setIcon(markup) {
    btnIcon.innerHTML = markup;
  }

  function setUI(playing) {
    isPlaying = playing;
    playBtn.className = playing ? "play-btn playing" : "play-btn";
    wave.className = playing ? "wave active" : "wave";
    setIcon(playing ? ICON_PAUSE : ICON_PLAY);
    if (playing) {
      setStatus("live", "يبث الآن");
    } else if (!wantPlay) {
      setStatus("", "اضغط للاستماع");
    }
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    }
    if (playing) {
      usage.start();
    } else {
      usage.stop();
    }
  }

  function clearTimers() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  }

  function armWatchdog(ms) {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(function () {
      watchdog = null;
      if (wantPlay) scheduleRetry();
    }, ms);
  }

  function startHeartbeat() {
    if (heartbeat) return;
    heartbeat = setInterval(function () {
      if (!wantPlay) return;
      if (isPlaying && srcActive) {
        if (Date.now() - lastProgressAt > STALL_TIMEOUT) scheduleRetry();
      } else if (!retryTimer && !watchdog) {
        scheduleRetry();
      }
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  function releaseSource() {
    srcActive = false;
    if (!audio) return;
    try {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    } catch (e) {}
  }

  // عنصر صوت واحد يُنشأ مرة واحدة (داخل ضغطة المستخدم) ويُعاد استخدامه،
  // لأن iOS يرفض التشغيل التلقائي في الخلفية على عناصر صوت جديدة.
  function getAudio() {
    if (audio) return audio;
    var el = new Audio();
    el.preload = "none";
    if (!IS_IOS) el.volume = volSlider.value / 100;

    el.addEventListener("playing", function () {
      if (!srcActive || !wantPlay) return;
      clearTimers();
      retryCount = 0;
      lastProgressAt = Date.now();
      setUI(true);
      applyMediaMetadata();
    });

    el.addEventListener("waiting", function () {
      if (!srcActive || !wantPlay) return;
      troubleAt = Date.now();
      setStatus("", "جاري التحميل...");
      armWatchdog(STALL_TIMEOUT);
    });

    el.addEventListener("stalled", function () {
      if (!srcActive || !wantPlay) return;
      troubleAt = Date.now();
      armWatchdog(STALL_TIMEOUT);
    });

    el.addEventListener("timeupdate", function () {
      if (!srcActive) return;
      lastProgressAt = Date.now();
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    });

    el.addEventListener("error", function () {
      if (!srcActive || !wantPlay) return;
      troubleAt = Date.now();
      scheduleRetry();
    });

    el.addEventListener("ended", function () {
      if (!srcActive || !wantPlay) return;
      scheduleRetry();
    });

    el.addEventListener("pause", function () {
      if (!srcActive || !wantPlay || !el.paused) return;
      // توقف بسبب مشاكل الاتصال: نعيد المحاولة، وغير ذلك: إيقاف من المستخدم/النظام
      if (Date.now() - troubleAt < 15000) {
        scheduleRetry();
      } else {
        stopPlayback();
      }
    });

    audio = el;
    return el;
  }

  // إعادة المحاولة بلا حد أقصى، والفاصل بين المحاولات يزيد تدريجياً حتى 15 ثانية
  function scheduleRetry() {
    clearTimers();
    if (!wantPlay) return;

    releaseSource();
    streamIndex = (streamIndex + 1) % STREAMS.length;
    retryCount += 1;
    isPlaying = false;
    wave.className = "wave";
    playBtn.className = "play-btn";
    setIcon(ICON_SPIN);
    usage.stop();

    if (navigator.onLine === false) {
      setStatus("err", "لا يوجد اتصال، سيُعاد الاتصال تلقائياً");
    } else {
      setStatus("", "إعادة الاتصال... (محاولة " + retryCount + ")");
    }

    var delay = Math.min(RETRY_DELAY_MIN + (retryCount - 1) * 1500, RETRY_DELAY_MAX);
    retryTimer = setTimeout(attemptPlay, delay);
  }

  function attemptPlay() {
    clearTimers();
    if (!wantPlay) return;

    if (navigator.onLine === false) {
      releaseSource();
      setIcon(ICON_SPIN);
      setStatus("err", "لا يوجد اتصال، سيُعاد الاتصال تلقائياً");
      retryTimer = setTimeout(attemptPlay, OFFLINE_POLL);
      return;
    }

    var el = getAudio();
    releaseSource();
    setIcon(ICON_SPIN);
    setStatus("", "جاري الاتصال بالبث...");
    armWatchdog(CONNECT_TIMEOUT);

    srcActive = true;
    el.src = STREAMS[streamIndex] + "?t=" + Date.now();

    var request = el.play();
    if (request && typeof request.catch === "function") {
      request.catch(function (err) {
        if (!srcActive || !wantPlay) return;
        if (err && err.name === "AbortError") return;
        if (err && err.name === "NotAllowedError") {
          stopPlayback();
          return;
        }
        scheduleRetry();
      });
    }
  }

  function startPlayback() {
    wantPlay = true;
    streamIndex = 0;
    retryCount = 0;
    startHeartbeat();
    attemptPlay();
  }

  function stopPlayback() {
    wantPlay = false;
    retryCount = 0;
    streamIndex = 0;
    clearTimers();
    stopHeartbeat();
    releaseSource();
    setUI(false);
  }

  playBtn.addEventListener("click", function () {
    if (wantPlay) {
      stopPlayback();
    } else {
      startPlayback();
    }
  });

  // iOS و بعض الأجهزة تتجاهل audio.volume، فنخفي شريط الصوت هناك
  function volumeSupported() {
    if (IS_IOS) return false;
    try {
      var probe = new Audio();
      probe.volume = 0.5;
      return probe.volume === 0.5;
    } catch (e) {
      return true;
    }
  }

  var volRow = document.querySelector(".vol-row");
  var canSetVolume = volumeSupported();
  if (!canSetVolume && volRow) volRow.hidden = true;

  function applyVolume(value) {
    var v = Math.min(100, Math.max(0, Number(value) || 0));
    volSlider.value = v;
    volVal.textContent = v + "%";
    if (audio && canSetVolume) audio.volume = v / 100;
    return v;
  }

  var savedVolume = readStore(KEY_VOLUME);
  if (savedVolume !== null) applyVolume(savedVolume);

  volSlider.addEventListener("input", function () {
    writeStore(KEY_VOLUME, applyVolume(volSlider.value));
  });

  var usage = (function () {
    var timer = null;
    var last = 0;
    var bytes = 0;

    function today() {
      var d = new Date();
      var m = String(d.getMonth() + 1).padStart(2, "0");
      var day = String(d.getDate()).padStart(2, "0");
      return d.getFullYear() + "-" + m + "-" + day;
    }

    function format(n) {
      if (n < 1024 * 1024) return (n / 1024).toFixed(2) + " KB";
      if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + " MB";
      return (n / (1024 * 1024 * 1024)).toFixed(3) + " GB";
    }

    function render() {
      usageVal.textContent = format(bytes);
      usageDate.textContent = "منذ بداية اليوم: " + today();
    }

    function save() {
      writeStore(KEY_BYTES, bytes);
      writeStore(KEY_DATE, today());
    }

    function load() {
      if (readStore(KEY_DATE) !== today()) {
        bytes = 0;
        save();
      } else {
        var stored = parseFloat(readStore(KEY_BYTES));
        bytes = isFinite(stored) && stored > 0 ? stored : 0;
      }
      render();
    }

    function tick() {
      var now = Date.now();
      var gap = now - last;
      last = now;

      if (readStore(KEY_DATE) !== today()) {
        bytes = 0;
      }

      var flowing = audio && !audio.paused && audio.readyState >= 3;
      if (flowing && gap > 0) {
        bytes += (Math.min(gap, MAX_TICK_GAP) / 1000) * BYTES_PER_SECOND;
      }
      save();
      render();
    }

    return {
      start: function () {
        if (timer) return;
        last = Date.now();
        timer = setInterval(tick, 1000);
      },
      stop: function () {
        if (!timer) return;
        clearInterval(timer);
        timer = null;
        tick();
      },
      reset: function () {
        bytes = 0;
        last = Date.now();
        save();
        render();
      },
      refresh: load
    };
  })();

  usage.refresh();

  usageReset.addEventListener("click", function () {
    usage.reset();
    usageReset.textContent = "تم";
    setTimeout(function () {
      usageReset.textContent = "تصفير";
    }, 1500);
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    if (!isPlaying) usage.refresh();
    if (wantPlay && !isPlaying) attemptPlay();
  });

  function applyMediaMetadata() {
    if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: "إذاعة القرآن الكريم",
      artist: "بث مباشر",
      album: "Holy Quran Radio",
      artwork: [
        { src: "icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "icon-512.png", sizes: "512x512", type: "image/png" }
      ]
    });
  }

  function bindMediaActions() {
    if (!("mediaSession" in navigator)) return;
    var actions = {
      play: function () {
        if (!wantPlay) startPlayback();
      },
      pause: function () {
        if (wantPlay) stopPlayback();
      },
      stop: function () {
        if (wantPlay) stopPlayback();
      }
    };
    Object.keys(actions).forEach(function (name) {
      try {
        navigator.mediaSession.setActionHandler(name, actions[name]);
      } catch (e) {}
    });
  }

  applyMediaMetadata();
  bindMediaActions();

  window.addEventListener("online", function () {
    if (!wantPlay) return;
    if (!isPlaying || Date.now() - lastProgressAt > 4000) {
      retryCount = 0;
      attemptPlay();
    }
  });

  window.addEventListener("offline", function () {
    if (wantPlay) setStatus("err", "لا يوجد اتصال، سيُعاد الاتصال تلقائياً");
  });

  (function setupInstall() {
    var standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;
    if (standalone) return;

    var box = document.getElementById("installBox");
    var installBtn = document.getElementById("installBtn");
    var howBtn = document.getElementById("iosHowBtn");
    var sheet = document.getElementById("installSheet");
    var sheetAndroid = document.getElementById("sheetAndroid");
    var androidManual = document.getElementById("androidManual");
    var sheetIos = document.getElementById("sheetIos");
    var sheetInstall = document.getElementById("sheetInstallBtn");
    var sheetDone = document.getElementById("sheetDone");
    var sheetTitle = document.getElementById("sheetTitle");
    var iosWarn = document.getElementById("iosBrowserWarn");
    var lead = sheet.querySelector(".sheet-lead");
    var root = document.documentElement;
    var deferred = null;
    var isMobile = IS_IOS || IS_ANDROID;

    // ---- لغة تعليمات التثبيت فقط (حسب لغة الجهاز) ----
    var RTL = { ar: 1, ur: 1 };
    var I18N = {
      ar: {
        title: "ثبّت التطبيق على جهازك",
        lead: "استمع للإذاعة بسرعة من الشاشة الرئيسية مثل أي تطبيق عادي.",
        installNow: "تثبيت الآن",
        a1: "اضغط على قائمة المتصفح <b>⋮</b> في أعلى الشاشة",
        a2: "اختر <b>تثبيت التطبيق</b> أو <b>إضافة إلى الشاشة الرئيسية</b>",
        a3: "افتح التطبيق من الشاشة الرئيسية",
        doneTitle: "تم تثبيت التطبيق",
        done: "تم التثبيت بنجاح ✅<br>افتح التطبيق من أيقونته على الشاشة الرئيسية.",
        iosWarn: "افتح هذا الرابط في متصفح Safari أولاً، ثم اتبع الخطوات التالية.",
        i1a: "اضغط زر المشاركة",
        i1b: "في شريط المتصفح (أو ⋯ ثم مشاركة)",
        i2: "مرّر لأسفل واختر <b>إضافة إلى الشاشة الرئيسية</b>",
        i3: "اضغط <b>إضافة</b> وسيظهر التطبيق على شاشتك"
      },
      en: {
        title: "Install the app on your device",
        lead: "Listen to the radio quickly from your home screen, like any regular app.",
        installNow: "Install now",
        a1: "Tap the browser menu <b>⋮</b> at the top of the screen",
        a2: "Choose <b>Install app</b> or <b>Add to Home screen</b>",
        a3: "Open the app from your home screen",
        doneTitle: "App installed",
        done: "Installed successfully ✅<br>Open the app from its icon on your home screen.",
        iosWarn: "Open this link in Safari first, then follow the steps below.",
        i1a: "Tap the Share button",
        i1b: "in the browser bar (or ⋯ then Share)",
        i2: "Scroll down and choose <b>Add to Home Screen</b>",
        i3: "Tap <b>Add</b> and the app will appear on your screen"
      },
      fr: {
        title: "Installez l’application sur votre appareil",
        lead: "Écoutez la radio rapidement depuis l’écran d’accueil, comme une application classique.",
        installNow: "Installer maintenant",
        a1: "Appuyez sur le menu du navigateur <b>⋮</b> en haut de l’écran",
        a2: "Choisissez <b>Installer l’application</b> ou <b>Ajouter à l’écran d’accueil</b>",
        a3: "Ouvrez l’application depuis l’écran d’accueil",
        doneTitle: "Application installée",
        done: "Installation réussie ✅<br>Ouvrez l’application depuis son icône sur l’écran d’accueil.",
        iosWarn: "Ouvrez d’abord ce lien dans Safari, puis suivez les étapes ci-dessous.",
        i1a: "Appuyez sur le bouton Partager",
        i1b: "dans la barre du navigateur (ou ⋯ puis Partager)",
        i2: "Faites défiler et choisissez <b>Sur l’écran d’accueil</b>",
        i3: "Appuyez sur <b>Ajouter</b> et l’application apparaîtra sur votre écran"
      },
      tr: {
        title: "Uygulamayı cihazınıza yükleyin",
        lead: "Radyoyu ana ekrandan, diğer uygulamalar gibi hızlıca dinleyin.",
        installNow: "Şimdi yükle",
        a1: "Ekranın üstündeki tarayıcı menüsüne <b>⋮</b> dokunun",
        a2: "<b>Uygulamayı yükle</b> veya <b>Ana ekrana ekle</b> seçeneğini seçin",
        a3: "Uygulamayı ana ekrandan açın",
        doneTitle: "Uygulama yüklendi",
        done: "Başarıyla yüklendi ✅<br>Uygulamayı ana ekrandaki simgesinden açın.",
        iosWarn: "Önce bu bağlantıyı Safari’de açın, sonra aşağıdaki adımları izleyin.",
        i1a: "Paylaş düğmesine dokunun",
        i1b: "tarayıcı çubuğunda (veya ⋯ ardından Paylaş)",
        i2: "Aşağı kaydırın ve <b>Ana Ekrana Ekle</b> seçeneğini seçin",
        i3: "<b>Ekle</b>’ye dokunun, uygulama ekranınızda görünecek"
      },
      ur: {
        title: "ایپ کو اپنے ڈیوائس پر انسٹال کریں",
        lead: "ہوم اسکرین سے عام ایپ کی طرح تیزی سے ریڈیو سنیں۔",
        installNow: "ابھی انسٹال کریں",
        a1: "اسکرین کے اوپر براؤزر مینو <b>⋮</b> پر ٹیپ کریں",
        a2: "<b>ایپ انسٹال کریں</b> یا <b>ہوم اسکرین میں شامل کریں</b> منتخب کریں",
        a3: "ایپ کو ہوم اسکرین سے کھولیں",
        doneTitle: "ایپ انسٹال ہو گئی",
        done: "کامیابی سے انسٹال ہو گئی ✅<br>ایپ کو ہوم اسکرین پر اس کے آئیکن سے کھولیں۔",
        iosWarn: "پہلے اس لنک کو Safari میں کھولیں، پھر درج ذیل مراحل پر عمل کریں۔",
        i1a: "شیئر بٹن دبائیں",
        i1b: "براؤزر بار میں (یا ⋯ پھر شیئر)",
        i2: "نیچے سکرول کریں اور <b>ہوم اسکرین میں شامل کریں</b> منتخب کریں",
        i3: "<b>شامل کریں</b> دبائیں، ایپ آپ کی اسکرین پر آ جائے گی"
      },
      id: {
        title: "Instal aplikasi di perangkat Anda",
        lead: "Dengarkan radio dengan cepat dari layar utama, seperti aplikasi biasa.",
        installNow: "Instal sekarang",
        a1: "Ketuk menu browser <b>⋮</b> di bagian atas layar",
        a2: "Pilih <b>Instal aplikasi</b> atau <b>Tambahkan ke layar utama</b>",
        a3: "Buka aplikasi dari layar utama",
        doneTitle: "Aplikasi terinstal",
        done: "Berhasil diinstal ✅<br>Buka aplikasi dari ikonnya di layar utama.",
        iosWarn: "Buka tautan ini di Safari terlebih dahulu, lalu ikuti langkah berikut.",
        i1a: "Ketuk tombol Bagikan",
        i1b: "di bilah browser (atau ⋯ lalu Bagikan)",
        i2: "Gulir ke bawah dan pilih <b>Tambah ke Layar Utama</b>",
        i3: "Ketuk <b>Tambah</b> dan aplikasi akan muncul di layar Anda"
      },
      es: {
        title: "Instala la aplicación en tu dispositivo",
        lead: "Escucha la radio rápidamente desde la pantalla de inicio, como cualquier app.",
        installNow: "Instalar ahora",
        a1: "Toca el menú del navegador <b>⋮</b> en la parte superior",
        a2: "Elige <b>Instalar aplicación</b> o <b>Añadir a la pantalla de inicio</b>",
        a3: "Abre la aplicación desde la pantalla de inicio",
        doneTitle: "Aplicación instalada",
        done: "Instalada correctamente ✅<br>Abre la aplicación desde su icono en la pantalla de inicio.",
        iosWarn: "Abre primero este enlace en Safari y luego sigue los pasos.",
        i1a: "Toca el botón Compartir",
        i1b: "en la barra del navegador (o ⋯ y luego Compartir)",
        i2: "Desplázate hacia abajo y elige <b>Añadir a pantalla de inicio</b>",
        i3: "Toca <b>Añadir</b> y la aplicación aparecerá en tu pantalla"
      },
      de: {
        title: "App auf deinem Gerät installieren",
        lead: "Höre das Radio schnell vom Startbildschirm aus, wie bei jeder anderen App.",
        installNow: "Jetzt installieren",
        a1: "Tippe oben auf das Browsermenü <b>⋮</b>",
        a2: "Wähle <b>App installieren</b> oder <b>Zum Startbildschirm hinzufügen</b>",
        a3: "Öffne die App vom Startbildschirm",
        doneTitle: "App installiert",
        done: "Erfolgreich installiert ✅<br>Öffne die App über ihr Symbol auf dem Startbildschirm.",
        iosWarn: "Öffne diesen Link zuerst in Safari und folge dann den Schritten.",
        i1a: "Tippe auf die Teilen-Schaltfläche",
        i1b: "in der Browserleiste (oder ⋯ und dann Teilen)",
        i2: "Scrolle nach unten und wähle <b>Zum Home-Bildschirm</b>",
        i3: "Tippe auf <b>Hinzufügen</b> und die App erscheint auf deinem Bildschirm"
      }
    };

    var deviceLang = "en";
    (function () {
      var list = navigator.languages && navigator.languages.length
        ? navigator.languages
        : [navigator.language || "en"];
      for (var i = 0; i < list.length; i++) {
        var code = String(list[i]).toLowerCase().split("-")[0];
        if (I18N[code]) { deviceLang = code; return; }
      }
    })();
    var T = I18N[deviceLang];

    sheet.lang = deviceLang;
    sheet.dir = RTL[deviceLang] ? "rtl" : "ltr";
    Array.prototype.forEach.call(sheet.querySelectorAll("[data-i18n]"), function (el) {
      var txt = T[el.getAttribute("data-i18n")];
      if (txt) el.innerHTML = txt;
    });


    // على الموبايل: شاشة التثبيت تغطي كل شيء، والإذاعة تظهر فقط داخل التطبيق المثبّت
    function openGate() {
      sheet.hidden = false;
      root.classList.add("gate-on");
    }

    function showDone() {
      deferred = null;
      sheetIos.hidden = true;
      sheetAndroid.hidden = true;
      lead.hidden = true;
      sheetTitle.textContent = T.doneTitle;
      sheetDone.hidden = false;
      box.hidden = true;
      if (isMobile) openGate();
    }

    if (isMobile) {
      if (IS_IOS) {
        sheetIos.hidden = false;
        // المتصفحات المدمجة (واتساب، فيسبوك...) لا تدعم الإضافة للشاشة الرئيسية
        iosWarn.hidden = /Safari/i.test(UA);
      } else {
        sheetAndroid.hidden = false;
      }
      openGate();
    }

    function doInstall() {
      if (!deferred) return;
      var promptEvent = deferred;
      promptEvent.prompt();
      promptEvent.userChoice.then(function (choice) {
        deferred = null;
        if (choice && choice.outcome === "accepted") {
          showDone();
        } else {
          sheetInstall.hidden = true;
          androidManual.hidden = false;
        }
      });
    }

    window.addEventListener("beforeinstallprompt", function (event) {
      event.preventDefault();
      deferred = event;
      if (!isMobile) {
        box.hidden = false;
        installBtn.hidden = false;
      }
      if (IS_ANDROID) {
        sheetAndroid.hidden = false;
        sheetInstall.hidden = false;
        androidManual.hidden = true;
      }
    });

    installBtn.addEventListener("click", doInstall);
    sheetInstall.addEventListener("click", doInstall);

    window.addEventListener("appinstalled", showDone);
  })();

  (function floatingDhikr() {
    var layer = document.getElementById("dhikr-layer");
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!layer || typeof layer.animate !== "function") return;

    var words = [
      "سُبْحَانَ اللهِ",
      "الْحَمْدُ لِلَّهِ",
      "لَا إِلَٰهَ إِلَّا اللهُ",
      "اللهُ أَكْبَرُ",
      "لَا حَوْلَ وَلَا قُوَّةَ إِلَّا بِاللهِ",
      "سُبْحَانَ اللهِ وَبِحَمْدِهِ",
      "أَسْتَغْفِرُ اللهَ",
      "اللَّهُمَّ صَلِّ عَلَى مُحَمَّدٍ ﷺ",
      "ٱللَّهُ",
      "ٱلرَّحْمَـٰنُ",
      "ٱلرَّحِيمُ",
      "ٱلْمَلِكُ",
      "ٱلْقُدُّوسُ",
      "ٱلسَّلَامُ",
      "ٱلْمُؤْمِنُ",
      "ٱلْعَزِيزُ",
      "ٱلْجَبَّارُ",
      "ٱلْخَالِقُ",
      "ٱلرَّزَّاقُ",
      "ٱلْغَفُورُ",
      "ٱلشَّكُورُ",
      "ٱلْحَلِيمُ",
      "ٱلْعَظِيمُ",
      "ٱلْكَرِيمُ",
      "ٱلْوَدُودُ",
      "ٱلْحَكِيمُ",
      "ٱللَّطِيفُ",
      "ٱلْخَبِيرُ",
      "ٱلتَّوَّابُ",
      "ٱلْقَدِيرُ",
      "ٱلْوَاحِدُ",
      "ٱلْأَحَدُ",
      "ٱلصَّمَدُ"
    ];

    var LANES = 10;
    var MAX_ACTIVE = 7;
    var busyUntil = [];
    for (var i = 0; i < LANES; i += 1) busyUntil.push(0);
    var active = 0;

    function pickLane() {
      var now = Date.now();
      var free = [];
      for (var k = 0; k < LANES; k += 1) {
        if (busyUntil[k] <= now) free.push(k);
      }
      return free.length ? free[Math.floor(Math.random() * free.length)] : -1;
    }

    function spawn() {
      if (document.hidden || reduce.matches || active >= MAX_ACTIVE) return;
      var lane = pickLane();
      if (lane === -1) return;

      var el = document.createElement("span");
      var seconds = 22 + 18 * Math.random();
      var rotation = 10 * (Math.random() - 0.5);
      var peak = 0.18 + 0.14 * Math.random();
      var left = 10 + 8 * lane + 2 * (Math.random() - 0.5);

      el.className = "dhikr-word";
      el.textContent = words[Math.floor(Math.random() * words.length)];
      el.style.left = left.toFixed(1) + "%";
      el.style.fontSize = (28 + 26 * Math.random()).toFixed(1) + "px";

      busyUntil[lane] = Date.now() + seconds * 1000;
      active += 1;
      layer.appendChild(el);

      var motion = el.animate(
        [
          { transform: "translateY(110vh) rotate(" + rotation + "deg)", opacity: 0, offset: 0 },
          { opacity: peak, offset: 0.08 },
          { opacity: peak, offset: 0.88 },
          { transform: "translateY(-18vh) rotate(" + rotation + "deg)", opacity: 0, offset: 1 }
        ],
        { duration: seconds * 1000, easing: "linear", fill: "forwards" }
      );

      motion.onfinish = function () {
        el.remove();
        active -= 1;
      };
    }

    for (var n = 0; n < 5; n += 1) setTimeout(spawn, 1800 * n);
    setInterval(spawn, 4000);
  })();

  (function setupUpdate() {
    if (!("serviceWorker" in navigator)) return;

    var bar = document.getElementById("updateBar");
    var btn = document.getElementById("updateBtn");
    var reg = null;
    var refreshing = false;

    function showBar() {
      if (bar) bar.hidden = false;
    }

    function track(worker) {
      worker.addEventListener("statechange", function () {
        if (worker.state === "installed" && navigator.serviceWorker.controller) showBar();
      });
    }

    function checkForUpdate() {
      if (reg) reg.update().catch(function () {});
    }

    window.addEventListener("load", function () {
      navigator.serviceWorker
        .register("sw.js", { updateViaCache: "none" })
        .then(function (r) {
          reg = r;
          if (r.waiting && navigator.serviceWorker.controller) showBar();
          if (r.installing) track(r.installing);
          r.addEventListener("updatefound", function () {
            if (r.installing) track(r.installing);
          });
          checkForUpdate();
          setInterval(checkForUpdate, 30 * 60 * 1000);
        })
        .catch(function () {});
    });

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) checkForUpdate();
    });

    window.addEventListener("online", checkForUpdate);

    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (!refreshing) return;
      window.location.reload();
    });

    if (btn) {
      btn.addEventListener("click", function () {
        refreshing = true;
        btn.disabled = true;
        btn.textContent = "جاري التحديث...";
        if (reg && reg.waiting) {
          reg.waiting.postMessage({ type: "SKIP_WAITING" });
          setTimeout(function () {
            window.location.reload();
          }, 4000);
        } else {
          window.location.reload();
        }
      });
    }
  })();
})();
