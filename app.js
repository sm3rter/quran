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
  var KEY_INSTALL_DISMISS = "quran_install_dismissed";

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
    var sheetIos = document.getElementById("sheetIos");
    var sheetInstall = document.getElementById("sheetInstallBtn");
    var iosWarn = document.getElementById("iosBrowserWarn");
    var deferred = null;
    var DISMISS_MS = 3 * 24 * 60 * 60 * 1000;

    function dismissedRecently() {
      var t = parseInt(readStore(KEY_INSTALL_DISMISS), 10);
      return isFinite(t) && Date.now() - t < DISMISS_MS;
    }

    function openSheet() {
      if (!sheet.hidden) return;
      sheet.hidden = false;
      var focusTarget = sheet.querySelector(".sheet-later");
      if (focusTarget) focusTarget.focus();
    }

    function closeSheet(remember) {
      if (sheet.hidden) return;
      sheet.hidden = true;
      if (remember) writeStore(KEY_INSTALL_DISMISS, Date.now());
    }

    Array.prototype.forEach.call(sheet.querySelectorAll("[data-close]"), function (el) {
      el.addEventListener("click", function () {
        closeSheet(true);
      });
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeSheet(true);
    });

    if (IS_IOS) {
      box.hidden = false;
      howBtn.hidden = false;
      sheetIos.hidden = false;
      // المتصفحات المدمجة (واتساب، فيسبوك...) لا تدعم الإضافة للشاشة الرئيسية
      iosWarn.hidden = /Safari/i.test(UA);
      howBtn.addEventListener("click", openSheet);
      if (!dismissedRecently()) setTimeout(openSheet, 1200);
    }

    function doInstall() {
      if (!deferred) return;
      var promptEvent = deferred;
      closeSheet(false);
      promptEvent.prompt();
      promptEvent.userChoice.then(function (choice) {
        deferred = null;
        installBtn.hidden = true;
        box.hidden = true;
        if (choice && choice.outcome === "dismissed") {
          writeStore(KEY_INSTALL_DISMISS, Date.now());
        }
      });
    }

    window.addEventListener("beforeinstallprompt", function (event) {
      event.preventDefault();
      deferred = event;
      box.hidden = false;
      installBtn.hidden = false;
      sheetAndroid.hidden = false;
      if ((IS_ANDROID || IS_IOS) && !dismissedRecently()) setTimeout(openSheet, 800);
    });

    installBtn.addEventListener("click", doInstall);
    sheetInstall.addEventListener("click", doInstall);

    window.addEventListener("appinstalled", function () {
      deferred = null;
      closeSheet(false);
      box.hidden = true;
    });
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
