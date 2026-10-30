(function () {
  "use strict";

  var STREAMS = [
    "https://stream.radiojar.com/8s5u5tpdtwzuv",
    "https://n10.radiojar.com/8s5u5tpdtwzuv",
    "https://n11.radiojar.com/8s5u5tpdtwzuv"
  ];

  var BITRATE_KBPS = 128;
  var BYTES_PER_SECOND = (BITRATE_KBPS * 1000) / 8;
  var MAX_RETRY = 6;
  var RETRY_DELAY = 3000;
  var CONNECT_TIMEOUT = 15000;
  var STALL_TIMEOUT = 12000;
  var MAX_TICK_GAP = 90000;

  var KEY_VOLUME = "quran_volume";
  var KEY_BYTES = "quran_bytes_total";
  var KEY_DATE = "quran_bytes_date";

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
  var wantPlay = false;
  var isPlaying = false;
  var gaveUp = false;
  var streamIndex = 0;
  var retryCount = 0;
  var retryTimer = null;
  var watchdog = null;

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

  function releaseAudio() {
    if (!audio) return;
    var old = audio;
    audio = null;
    try {
      old.pause();
      old.removeAttribute("src");
      old.load();
    } catch (e) {}
  }

  function createAudio() {
    releaseAudio();
    var el = new Audio();
    el.preload = "none";
    el.volume = volSlider.value / 100;

    el.addEventListener("playing", function () {
      if (el !== audio) return;
      clearTimers();
      retryCount = 0;
      setUI(true);
      applyMediaMetadata();
    });

    el.addEventListener("waiting", function () {
      if (el !== audio || !wantPlay) return;
      setStatus("", "جاري التحميل...");
      armWatchdog(STALL_TIMEOUT);
    });

    el.addEventListener("stalled", function () {
      if (el !== audio || !wantPlay) return;
      armWatchdog(STALL_TIMEOUT);
    });

    el.addEventListener("timeupdate", function () {
      if (el !== audio || !watchdog) return;
      clearTimeout(watchdog);
      watchdog = null;
    });

    el.addEventListener("error", function () {
      if (el !== audio || !wantPlay) return;
      scheduleRetry();
    });

    el.addEventListener("ended", function () {
      if (el !== audio || !wantPlay) return;
      scheduleRetry();
    });

    el.addEventListener("pause", function () {
      if (el !== audio || !wantPlay) return;
      stopPlayback();
    });

    audio = el;
  }

  function scheduleRetry() {
    clearTimers();
    if (!wantPlay) return;

    if (retryCount >= MAX_RETRY) {
      wantPlay = false;
      gaveUp = true;
      releaseAudio();
      setUI(false);
      setStatus("err", "تعذّر الاتصال، تحقق من الإنترنت");
      return;
    }

    streamIndex = (streamIndex + 1) % STREAMS.length;
    retryCount += 1;
    isPlaying = false;
    wave.className = "wave";
    playBtn.className = "play-btn";
    setIcon(ICON_SPIN);
    usage.stop();
    setStatus("", "إعادة الاتصال... (" + retryCount + "/" + MAX_RETRY + ")");
    retryTimer = setTimeout(attemptPlay, RETRY_DELAY);
  }

  function attemptPlay() {
    clearTimers();
    if (!wantPlay) return;

    createAudio();
    var el = audio;
    setIcon(ICON_SPIN);
    setStatus("", "جاري الاتصال بالبث...");
    armWatchdog(CONNECT_TIMEOUT);

    el.src = STREAMS[streamIndex] + "?t=" + Date.now();

    var request = el.play();
    if (request && typeof request.catch === "function") {
      request.catch(function (err) {
        if (el !== audio || !wantPlay) return;
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
    gaveUp = false;
    streamIndex = 0;
    retryCount = 0;
    attemptPlay();
  }

  function stopPlayback() {
    wantPlay = false;
    gaveUp = false;
    retryCount = 0;
    streamIndex = 0;
    clearTimers();
    releaseAudio();
    setUI(false);
  }

  playBtn.addEventListener("click", function () {
    if (wantPlay) {
      stopPlayback();
    } else {
      startPlayback();
    }
  });

  function applyVolume(value) {
    var v = Math.min(100, Math.max(0, Number(value) || 0));
    volSlider.value = v;
    volVal.textContent = v + "%";
    if (audio) audio.volume = v / 100;
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
    if (!document.hidden && !isPlaying) usage.refresh();
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
    if (gaveUp) {
      startPlayback();
    }
  });

  window.addEventListener("offline", function () {
    if (wantPlay) setStatus("err", "لا يوجد اتصال بالإنترنت");
  });

  (function setupInstall() {
    var box = document.getElementById("installBox");
    var button = document.getElementById("installBtn");
    var iosHint = document.getElementById("iosHint");
    var deferred = null;

    var standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;
    if (standalone) return;

    var ua = navigator.userAgent || "";
    var isIOS = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);

    if (isIOS) {
      box.hidden = false;
      iosHint.hidden = false;
    }

    window.addEventListener("beforeinstallprompt", function (event) {
      event.preventDefault();
      deferred = event;
      box.hidden = false;
      button.hidden = false;
    });

    button.addEventListener("click", function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.then(function () {
        deferred = null;
        button.hidden = true;
        box.hidden = true;
      });
    });

    window.addEventListener("appinstalled", function () {
      deferred = null;
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

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }
})();
