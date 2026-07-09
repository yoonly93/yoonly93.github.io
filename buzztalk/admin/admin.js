// 실검톡 운영 콘솔 — Firebase Auth + Firestore + Cloud Functions에 직접 연결되는
// 정적 페이지 스크립트 (번들러 없이 브라우저 ES 모듈로 그대로 로드됨).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInAnonymously,
  signOut,
  onAuthStateChanged,
  getIdTokenResult,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  onSnapshot,
  query,
  orderBy,
  limit,
  where,
  getDocs,
  getCountFromServer,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
  getFunctions,
  httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyD2xYw8zSB3jVILUFCZfdcmdQRSCfOtJgM",
  authDomain: "buzztalk-yoonly93.firebaseapp.com",
  projectId: "buzztalk-yoonly93",
  storageBucket: "buzztalk-yoonly93.firebasestorage.app",
  messagingSenderId: "648177060118",
  appId: "1:648177060118:web:1a37d88eb667ba9b48a837",
};

const FUNCTIONS_REGION = "asia-northeast3";
const ROOMS_LIST_LIMIT = 200;
const REPORTS_LIST_LIMIT = 100;
const LOGS_LIST_LIMIT = 20;
const AUTH_CHECK_TIMEOUT_MS = 8000;
const LOGIN_POPUP_TIMEOUT_MS = 20000;

const app = initializeApp(firebaseConfig);
const chatApp = initializeApp(firebaseConfig, "admin-anonymous-chat");
const auth = getAuth(app);
const chatAuth = getAuth(chatApp);
const db = getFirestore(app);
const functions = getFunctions(app, FUNCTIONS_REGION);
const chatFunctions = getFunctions(chatApp, FUNCTIONS_REGION);

const callApplyAdminAction = httpsCallable(functions, "applyAdminAction");
const callManageBannedWord = httpsCallable(functions, "manageBannedWord");
const callApplyUserRestriction = httpsCallable(functions, "applyUserRestriction");
const callSendAnonymousMessage = httpsCallable(chatFunctions, "sendMessage");

// ---------------------------------------------------------------------------
// 화면 상태 전환 (로그인 필요 / 권한 없음 / 콘솔)
// ---------------------------------------------------------------------------

const screens = {
  loading: document.getElementById("admin-screen-loading"),
  login: document.getElementById("admin-screen-login"),
  forbidden: document.getElementById("admin-screen-forbidden"),
  console: document.getElementById("admin-screen-console"),
};
const consoleHeader = document.getElementById("admin-console-header");

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    if (!el) return;
    el.hidden = key !== name;
  });
  if (consoleHeader) {
    consoleHeader.hidden = name !== "console";
  }
}

function showLoginMessage(message) {
  showScreen("login");
  if (loginError) {
    loginError.textContent = message;
  }
}

const loginButton = document.getElementById("admin-login-button");
const loginError = document.getElementById("admin-login-error");
const signOutButtons = document.querySelectorAll("[data-admin-signout]");
const adminIdentityEl = document.getElementById("admin-identity");

// GitHub Pages(yoonly93.github.io)와 authDomain(firebaseapp.com)이 서로 다른
// 도메인이라 signInWithRedirect는 서드파티 저장소 차단 브라우저에서 영원히
// 멈출 수 있다. 팝업 방식은 postMessage 기반이라 크로스 도메인에서도 동작한다.
loginButton?.addEventListener("click", async () => {
  loginError.textContent = "";
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  loginButton.disabled = true;
  showLoginMessage("Google 로그인 창을 확인하세요.");
  try {
    const credential = await withTimeout(
      signInWithPopup(auth, provider),
      "로그인 창 응답이 지연되고 있습니다. 팝업 차단을 확인한 뒤 다시 시도해 주세요.",
      LOGIN_POPUP_TIMEOUT_MS
    );
    await handleSignedInUser(credential.user);
  } catch (error) {
    console.error("로그인 실패", error);
    loginError.textContent = describeLoginError(error);
    loginButton.disabled = false;
  }
});

function describeLoginError(error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : "";
  switch (code) {
    case "auth/popup-blocked":
      return "브라우저가 로그인 팝업을 차단했습니다. 주소창의 팝업 차단 아이콘에서 이 사이트의 팝업을 허용한 뒤 다시 시도해 주세요.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "로그인 창이 닫혔습니다. 다시 시도해 주세요.";
    case "auth/unauthorized-domain":
      return "이 도메인이 Firebase Auth 승인된 도메인 목록에 없습니다. Firebase 콘솔 > Authentication > Settings에서 도메인을 추가해 주세요.";
    case "auth/network-request-failed":
      return "네트워크 오류로 로그인하지 못했습니다. 연결 상태를 확인해 주세요.";
    default:
      return "로그인에 실패했습니다: " + describeError(error);
  }
}

signOutButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    teardownConsole();
    signOut(auth).catch((error) => console.error("로그아웃 실패", error));
  });
});

function describeError(error) {
  if (error && typeof error === "object") {
    if ("message" in error && error.message) return String(error.message);
  }
  return String(error);
}

function withTimeout(promise, message, ms = AUTH_CHECK_TIMEOUT_MS) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}

async function getAdminClaims(user) {
  const cachedTokenResult = await withTimeout(
    getIdTokenResult(user, false),
    "권한 확인 시간이 초과되었습니다. 다시 로그인해 주세요."
  );
  const cachedClaims = cachedTokenResult.claims || {};
  if (cachedClaims.admin === true || cachedClaims.operator === true) {
    return cachedClaims;
  }

  const refreshedTokenResult = await withTimeout(
    getIdTokenResult(user, true),
    "권한 갱신 시간이 초과되었습니다. 다시 로그인해 주세요."
  );
  return refreshedTokenResult.claims || {};
}

let activeUnsubscribers = [];
function teardownConsole() {
  activeUnsubscribers.forEach((unsub) => {
    try {
      unsub();
    } catch (_err) {
      // 이미 해제된 리스너는 무시한다.
    }
  });
  activeUnsubscribers = [];
  selectedChatRoomId = null;
}

showScreen("login");

// 인증 상태 확인이 어떤 이유로든(네트워크, SDK 내부 오류 등) 끝나지 않으면
// "확인 중입니다" 화면에서 영원히 멈춰 보이므로, 일정 시간 안에 인증 상태가
// 결정되지 않으면 강제로 로그인 화면으로 되돌린다.
const AUTH_INIT_TIMEOUT_MS = 12000;
let authInitSettled = false;
const authInitTimeoutId = window.setTimeout(() => {
  if (authInitSettled) return;
  console.error("로그인 상태 확인이 시간 내에 끝나지 않았습니다.");
  showLoginMessage("로그인 확인이 지연되고 있습니다. 새로고침 후 다시 시도해 주세요.");
  if (loginButton) loginButton.disabled = false;
}, AUTH_INIT_TIMEOUT_MS);

function settleAuthInit() {
  authInitSettled = true;
  window.clearTimeout(authInitTimeoutId);
}

let authCheckRunId = 0;

async function handleSignedInUser(user) {
  const runId = ++authCheckRunId;
  if (!user) return;

  showLoginMessage("권한을 확인하는 중입니다.");
  if (loginButton) loginButton.disabled = true;
  try {
    const claims = await getAdminClaims(user);
    if (runId !== authCheckRunId) return;
    const isAuthorized = claims.admin === true || claims.operator === true;
    if (!isAuthorized) {
      showScreen("forbidden");
      const forbiddenEmail = document.getElementById("admin-forbidden-email");
      if (forbiddenEmail) forbiddenEmail.textContent = user.email || user.uid;
      if (loginButton) loginButton.disabled = false;
      return;
    }

    if (adminIdentityEl) {
      adminIdentityEl.textContent = (user.email || user.uid) + (claims.admin ? " · admin" : " · operator");
    }
    showScreen("console");
    initConsole();
  } catch (error) {
    if (runId !== authCheckRunId) return;
    console.error("권한 확인 실패", error);
    showLoginMessage("권한 확인 중 오류가 발생했습니다: " + describeError(error));
    if (loginButton) loginButton.disabled = false;
  }
}

onAuthStateChanged(auth, async (user) => {
  settleAuthInit();
  if (!user) {
    authCheckRunId += 1;
    teardownConsole();
    showScreen("login");
    if (loginError) loginError.textContent = "";
    if (loginButton) loginButton.disabled = false;
    return;
  }

  await handleSignedInUser(user);
});

// ---------------------------------------------------------------------------
// 콘솔 초기화 — 로그인 + 권한 확인 후에만 호출된다.
// ---------------------------------------------------------------------------

let latestRooms = [];
let latestActiveRooms = [];
let latestReports = [];
let selectedReportId = null;
let reportsTab = "pending"; // pending | hold | done
let roomSortMode = "recent"; // recent | participants | messages
let selectedChatRoomId = null;
let anonymousChatAuthReady = null;
let staticControlsWired = false;

function initConsole() {
  teardownConsole();
  wireStaticControls();
  setAdminPage((window.location.hash || "#dashboard").slice(1));
  watchRooms();
  watchActiveRooms();
  watchReports();
  watchOperationLogs();
  watchBannedWords();
}

function wireStaticControls() {
  if (staticControlsWired) return;
  staticControlsWired = true;

  document.querySelectorAll("[data-report-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      reportsTab = btn.getAttribute("data-report-tab");
      document.querySelectorAll("[data-report-tab]").forEach((b) => {
        b.classList.toggle("is-active", b === btn);
      });
      renderReportsTable();
    });
  });

  document.querySelectorAll("[data-admin-nav]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      setAdminPage(link.getAttribute("data-admin-nav"));
    });
  });

  document.querySelectorAll("[data-room-sort]").forEach((btn) => {
    btn.addEventListener("click", () => {
      roomSortMode = btn.getAttribute("data-room-sort") || "recent";
      document.querySelectorAll("[data-room-sort]").forEach((candidate) => {
        candidate.classList.toggle("is-active", candidate === btn);
      });
      renderRoomsPanel();
    });
  });

  document.getElementById("admin-live-rooms-refresh")?.addEventListener("click", async () => {
    await refreshRoomsOnce();
  });

  const wordForm = document.getElementById("admin-word-form");
  wordForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const expression = document.getElementById("admin-word-expression").value.trim();
    const category = document.getElementById("admin-word-category").value;
    if (!expression) return;
    setBusy(wordForm, true);
    try {
      await callManageBannedWord({ op: "add", expression, category });
      wordForm.reset();
    } catch (error) {
      alert("금칙어 추가 실패: " + describeError(error));
    } finally {
      setBusy(wordForm, false);
    }
  });

  const restrictionForm = document.getElementById("admin-restriction-form");
  restrictionForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitRestriction(168, restrictionForm);
  });
  document.getElementById("admin-restriction-24h")?.addEventListener("click", async () => {
    await submitRestriction(24, restrictionForm);
  });
  document.getElementById("admin-restriction-7d")?.addEventListener("click", async () => {
    await submitRestriction(168, restrictionForm);
  });

  document.getElementById("admin-chat-refresh")?.addEventListener("click", () => {
    if (selectedChatRoomId) loadChatMessages(selectedChatRoomId);
  });

  document.getElementById("admin-chat-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitAdminChatMessage();
  });
}

function setAdminPage(pageName) {
  const pages = [...document.querySelectorAll("[data-admin-page]")].map((section) =>
    section.getAttribute("data-admin-page")
  );
  const nextPage = pages.includes(pageName) ? pageName : "dashboard";
  document.querySelectorAll("[data-admin-page]").forEach((section) => {
    section.hidden = section.getAttribute("data-admin-page") !== nextPage;
  });
  document.querySelectorAll("[data-admin-nav]").forEach((link) => {
    link.classList.toggle("is-active", link.getAttribute("data-admin-nav") === nextPage);
  });
  if (window.location.hash !== `#${nextPage}`) {
    window.history.replaceState(null, "", `#${nextPage}`);
  }
}

async function submitRestriction(durationHours, formEl) {
  const targetUserId = document.getElementById("admin-restriction-target").value.trim();
  const reason = document.getElementById("admin-restriction-reason").value;
  const memo = document.getElementById("admin-restriction-memo").value.trim();
  if (!targetUserId) {
    alert("대상 사용자 ID를 입력하세요.");
    return;
  }
  setBusy(formEl, true);
  try {
    await callApplyUserRestriction({ targetUserId, reason, memo, durationHours });
    alert(`${targetUserId} 사용자에게 ${durationHours}시간 제한을 적용했습니다.`);
    document.getElementById("admin-restriction-target").value = "";
    document.getElementById("admin-restriction-memo").value = "";
  } catch (error) {
    alert("사용자 제한 적용 실패: " + describeError(error));
  } finally {
    setBusy(formEl, false);
  }
}

function setBusy(container, busy) {
  if (!container) return;
  container.querySelectorAll("button, input, select, textarea").forEach((el) => {
    el.disabled = busy;
  });
}

// ---------------------------------------------------------------------------
// Rooms (+ 활성 방 지표, 푸시 후보 패널)
// ---------------------------------------------------------------------------

function roomsQuery() {
  return query(collection(db, "rooms"), orderBy("lastActiveAt", "desc"), limit(ROOMS_LIST_LIMIT));
}

// 실검에서 내려갔다 재진입한 방은 lastActiveAt이 갱신되지 않아 위 쿼리의
// 상위 200개 밖으로 밀려날 수 있으므로, 활성 방은 state 조건으로 따로 구독한다.
function activeRoomsQuery() {
  return query(collection(db, "rooms"), where("state", "==", "active"), limit(50));
}

function watchRooms() {
  const unsub = onSnapshot(
    roomsQuery(),
    (snap) => {
      latestRooms = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderRoomsPanel();
    },
    (error) => {
      console.error("rooms 구독 실패", error);
      renderListError("admin-rooms-list", error);
    }
  );
  activeUnsubscribers.push(unsub);
}

function watchActiveRooms() {
  const unsub = onSnapshot(
    activeRoomsQuery(),
    (snap) => {
      latestActiveRooms = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderLiveRoomsPanel();
      renderChatRoomPicker();
      renderPushPanel();
      renderMetrics();
    },
    (error) => {
      console.error("active rooms 구독 실패", error);
      renderListError("admin-live-room-list", error);
      renderListError("admin-chat-room-list", error);
      renderListError("admin-push-list", error);
    }
  );
  activeUnsubscribers.push(unsub);
}

async function refreshRoomsOnce() {
  const button = document.getElementById("admin-live-rooms-refresh");
  if (button) button.disabled = true;
  try {
    const [snap, activeSnap] = await Promise.all([getDocs(roomsQuery()), getDocs(activeRoomsQuery())]);
    latestRooms = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    latestActiveRooms = activeSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderLiveRoomsPanel();
    renderRoomsPanel();
    renderChatRoomPicker();
    renderPushPanel();
    renderMetrics();
  } catch (error) {
    console.error("rooms 새로고침 실패", error);
    renderListError("admin-live-room-list", error);
  } finally {
    if (button) button.disabled = false;
  }
}

function liveTrendRooms() {
  return latestActiveRooms
    .filter((room) => Number.isFinite(Number(room.rank)) && Number(room.rank) >= 1 && Number(room.rank) <= 10)
    .sort((a, b) => Number(a.rank) - Number(b.rank))
    .slice(0, 10);
}

function renderLiveRoomsPanel() {
  const list = document.getElementById("admin-live-room-list");
  if (!list) return;
  const rooms = liveTrendRooms();
  if (rooms.length === 0) {
    list.innerHTML = "<li><span>현재 표시할 실시간 검색어 채팅방이 없습니다.</span></li>";
    return;
  }
  list.innerHTML = rooms
    .map((room) => `<li class="admin-room-row">
      <strong>${Number(room.rank)}위 · ${escapeHtml(room.keywordText || room.id)}</strong>
      <span>참여 ${formatCount(room.participantCount)}명 · 채팅 ${formatCount(room.messageCount)}개 · ${roomStateLabel(room)}</span>
      <div class="action-row admin-inline-actions">
        <button type="button" class="small-button secondary-small" data-chat-open="${room.id}">채팅 열기</button>
      </div>
    </li>`)
    .join("");
  // 실검 활성방 페이지에는 채팅 슬롯이 없으니 익명 채팅 페이지로 이동해 연다.
  wireChatOpenButtons(list, { navigateTo: "admin-chat" });
}

function renderRoomsPanel() {
  const list = document.getElementById("admin-rooms-list");
  if (!list) return;
  // 전체 방 목록 — 최신순은 쿼리 순서(lastActiveAt desc)를 그대로 유지한다.
  const rooms = [...latestRooms];
  if (roomSortMode !== "recent") {
    rooms.sort((a, b) => {
      const primaryKey = roomSortMode === "messages" ? "messageCount" : "participantCount";
      const secondaryKey = roomSortMode === "messages" ? "participantCount" : "messageCount";
      const primaryDiff = (b[primaryKey] ?? 0) - (a[primaryKey] ?? 0);
      if (primaryDiff !== 0) return primaryDiff;
      const secondaryDiff = (b[secondaryKey] ?? 0) - (a[secondaryKey] ?? 0);
      if (secondaryDiff !== 0) return secondaryDiff;
      return Number(a.rank ?? 9999) - Number(b.rank ?? 9999);
    });
  }
  if (rooms.length === 0) {
    list.innerHTML = "<li><span>표시할 채팅방이 없습니다.</span></li>";
    return;
  }
  list.innerHTML = rooms
    .map((room) => {
      const pushLabel = room.pushBlockedByOperator ? "푸시 차단" : room.pushAllowed === false ? "푸시 후보" : "푸시 허용";
      return `<li class="admin-room-row">
        <strong>${escapeHtml(room.keywordText || room.roomId || room.id)}</strong>
        <span>${roomStateLabel(room)} · 참여 ${formatCount(room.participantCount)}명 · 채팅 ${formatCount(room.messageCount)}개 · ${pushLabel}</span>
        <div class="action-row admin-inline-actions">
          <button type="button" class="small-button secondary-small" data-chat-open="${room.id}">채팅 열기</button>
        </div>
      </li>`;
    })
    .join("");

  // 같은 페이지 오른쪽 슬롯에 채팅을 연다(페이지 이동 없음).
  wireChatOpenButtons(list, { slotId: "admin-rooms-chat-slot" });
}

function renderChatRoomPicker() {
  const list = document.getElementById("admin-chat-room-list");
  if (!list) return;
  const rooms = liveTrendRooms();
  if (rooms.length === 0) {
    list.innerHTML = "<li><span>현재 입장 가능한 실시간 검색어 방이 없습니다.</span></li>";
    return;
  }
  list.innerHTML = rooms
    .map((room) => `<li class="admin-room-row">
      <strong>${Number(room.rank)}위 · ${escapeHtml(room.keywordText || room.id)}</strong>
      <span>참여 ${formatCount(room.participantCount)}명 · 채팅 ${formatCount(room.messageCount)}개</span>
      <div class="action-row admin-inline-actions">
        <button type="button" class="small-button ${selectedChatRoomId === room.id ? "" : "secondary-small"}" data-chat-open="${room.id}">
          ${selectedChatRoomId === room.id ? "선택됨" : "선택"}
        </button>
      </div>
    </li>`)
    .join("");
  wireChatOpenButtons(list);
}

// 채팅 패널은 DOM이 하나뿐이라, 여는 페이지의 슬롯으로 옮겨 붙인다.
// navigateTo가 있으면 그 페이지로 전환한 뒤 연다(전용 슬롯이 없는 목록용).
function wireChatOpenButtons(container, options = {}) {
  const slotId = options.slotId || "admin-chat-slot";
  container.querySelectorAll("[data-chat-open]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (options.navigateTo) {
        setAdminPage(options.navigateTo);
      }
      openAdminChatRoom(btn.getAttribute("data-chat-open"), slotId);
    });
  });
}

function mountChatPanel(slotId) {
  const chatRoom = document.getElementById("admin-chat-room");
  const slot = document.getElementById(slotId);
  if (!chatRoom || !slot) return;
  if (chatRoom.parentElement !== slot) {
    slot.appendChild(chatRoom);
  }
  document.querySelectorAll("[data-chat-slot]").forEach((candidate) => {
    const placeholder = candidate.querySelector("[data-chat-placeholder]");
    if (placeholder) {
      placeholder.hidden = candidate.contains(chatRoom);
    }
  });
  chatRoom.hidden = false;
}

function renderMetrics() {
  const activeRooms = latestActiveRooms;
  setText("admin-metric-live-rooms", String(liveTrendRooms().length));

  const messageSum = activeRooms.reduce((sum, r) => sum + (typeof r.messageCount === "number" ? r.messageCount : 0), 0);
  setText("admin-metric-messages", messageSum.toLocaleString("ko-KR"));

  const pushCandidates = activeRooms.filter(
    (r) => (r.participantCount ?? 0) >= 10 && r.pushAllowed !== false && !r.pushBlockedByOperator
  );
  setText("admin-metric-push-candidates", String(pushCandidates.length));
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function renderPushPanel() {
  const list = document.getElementById("admin-push-list");
  if (!list) return;
  const candidates = latestActiveRooms.filter((r) => (r.participantCount ?? 0) >= 10);

  if (candidates.length === 0) {
    list.innerHTML = "<li><span>참여자 10명 이상인 활성 방이 없습니다.</span></li>";
    return;
  }

  list.innerHTML = candidates
    .map((room) => {
      const blocked = room.pushBlockedByOperator === true;
      const statusLabel = blocked ? "차단됨" : room.pushAllowed === false ? "허용 안 됨" : "허용";
      return `<li>
        <strong>${escapeHtml(room.keywordText || room.id)}</strong>
        <span>참여 ${room.participantCount ?? 0}명 · 상태: ${statusLabel}</span>
        <div class="action-row admin-inline-actions">
          <button type="button" class="small-button ${blocked ? "" : "secondary-small"}" data-push-toggle="${room.id}" data-push-next="${blocked}">
            ${blocked ? "차단 해제" : "방 푸시 차단"}
          </button>
        </div>
      </li>`;
    })
    .join("");

  list.querySelectorAll("[data-push-toggle]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const roomId = btn.getAttribute("data-push-toggle");
      const nextAllowed = btn.getAttribute("data-push-next") === "true";
      const reason = nextAllowed ? "" : prompt("푸시 차단 사유를 입력하세요 (선택)") || "";
      btn.disabled = true;
      try {
        await callApplyAdminAction({
          actionType: "set_room_push_policy",
          roomId,
          pushAllowed: nextAllowed,
          reason,
        });
      } catch (error) {
        alert("푸시 정책 변경 실패: " + describeError(error));
      } finally {
        btn.disabled = false;
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Anonymous chat participation
// ---------------------------------------------------------------------------

async function ensureAnonymousChatAuth() {
  if (chatAuth.currentUser) {
    return chatAuth.currentUser.uid;
  }
  if (!anonymousChatAuthReady) {
    anonymousChatAuthReady = signInAnonymously(chatAuth)
      .then((result) => {
        anonymousChatAuthReady = null;
        return result.user.uid;
      })
      .catch((error) => {
        anonymousChatAuthReady = null;
        throw error;
      });
  }
  return anonymousChatAuthReady;
}

function openAdminChatRoom(roomId, slotId = "admin-chat-slot") {
  if (!roomId) return;
  selectedChatRoomId = roomId;
  const room =
    latestActiveRooms.find((candidate) => candidate.id === roomId) ||
    latestRooms.find((candidate) => candidate.id === roomId);
  mountChatPanel(slotId);

  setText("admin-chat-status", "익명 세션 준비 중");
  setText("admin-chat-room-title", room?.keywordText || roomId);
  setText(
    "admin-chat-room-meta",
    `${roomStateLabel(room)} · 참여 ${room?.participantCount ?? 0}명 · 메시지 ${room?.messageCount ?? 0}개`
  );
  setText("admin-chat-nickname-preview", `다음 닉네임 예시: ${makeRandomNickname()}`);
  renderChatRoomPicker();
  loadChatMessages(roomId);
  document.getElementById("admin-chat-room")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function loadChatMessages(roomId) {
  const messagesEl = document.getElementById("admin-chat-messages");
  if (!messagesEl) return;
  messagesEl.innerHTML = '<p class="muted-copy">메시지를 불러오는 중입니다.</p>';
  try {
    const uid = await ensureAnonymousChatAuth();
    setText("admin-chat-status", `익명 참여자 ${shortenId(uid)}`);
    const snap = await getDocs(
      query(collection(db, "rooms", roomId, "messages"), orderBy("createdAt", "desc"), limit(80))
    );
    const messages = snap.docs
      .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
      .reverse();
    renderChatMessages(messages, uid);
  } catch (error) {
    console.error("채팅 메시지 조회 실패", error);
    messagesEl.innerHTML = `<p class="muted-copy">${escapeHtml("메시지를 불러오지 못했습니다: " + describeError(error))}</p>`;
    setText("admin-chat-status", "조회 실패");
  }
}

function renderChatMessages(messages, currentAnonymousUid) {
  const messagesEl = document.getElementById("admin-chat-messages");
  if (!messagesEl) return;
  if (messages.length === 0) {
    messagesEl.innerHTML = '<p class="muted-copy">아직 메시지가 없습니다.</p>';
    return;
  }
  messagesEl.innerHTML = messages
    .map((message) => {
      const mine = message.anonymousUserId === currentAnonymousUid;
      const hidden = message.hidden === true;
      const body = hidden ? "운영정책에 따라 숨겨진 메시지입니다" : message.text || message.body || "";
      return `<article class="admin-chat-message ${mine ? "is-mine" : ""} ${hidden ? "is-hidden" : ""}">
        <div class="admin-chat-message-meta">
          <strong>${escapeHtml(message.nicknameSnapshot || message.nickname || "익명")}</strong>
          <time>${formatTimestamp(message.createdAt, true)}</time>
        </div>
        <p>${escapeHtml(body)}</p>
      </article>`;
    })
    .join("");
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function submitAdminChatMessage() {
  const form = document.getElementById("admin-chat-form");
  const input = document.getElementById("admin-chat-input");
  const body = input?.value.trim() || "";
  if (!selectedChatRoomId || !body) return;

  const nickname = makeRandomNickname();
  setBusy(form, true);
  setText("admin-chat-status", `${nickname} 전송 중`);
  try {
    await ensureAnonymousChatAuth();
    await callSendAnonymousMessage({
      roomId: selectedChatRoomId,
      body,
      nickname,
    });
    input.value = "";
    setText("admin-chat-nickname-preview", `마지막 전송 닉네임: ${nickname} · 다음 전송 때 다시 바뀝니다.`);
    await loadChatMessages(selectedChatRoomId);
  } catch (error) {
    console.error("익명 메시지 전송 실패", error);
    alert("메시지 전송 실패: " + describeError(error));
    setText("admin-chat-status", "전송 실패");
  } finally {
    setBusy(form, false);
  }
}

function makeRandomNickname() {
  const adjectives = [
    "파란", "빨간", "노란", "초록", "보라", "하얀", "까만", "분홍", "주황",
    "조용한", "행복한", "용감한", "엉뚱한", "씩씩한", "다정한", "느긋한", "상큼한", "포근한", "수줍은",
  ];
  const nouns = [
    "여우", "고양이", "강아지", "판다", "토끼", "사자", "호랑이", "부엉이",
    "다람쥐", "고래", "펭귄", "너구리", "수달", "오리", "늑대", "사슴", "햄스터", "고슴도치",
  ];
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adjective} ${noun}`;
}

function roomStateLabel(room) {
  if (!room) return "상태 확인 중";
  return { active: "대화 중", archived: "보관됨", closed: "종료됨", deleted: "삭제됨" }[room.state] || room.state || "상태 없음";
}

// ---------------------------------------------------------------------------
// Reports (목록 + 상세 + 액션)
// ---------------------------------------------------------------------------

function watchReports() {
  const q = query(collection(db, "reports"), orderBy("createdAt", "desc"), limit(REPORTS_LIST_LIMIT));
  const unsub = onSnapshot(
    q,
    (snap) => {
      latestReports = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderReportsTable();
      refreshPendingCount();
    },
    (error) => {
      console.error("reports 구독 실패", error);
      renderListError("admin-reports-body", error, true);
    }
  );
  activeUnsubscribers.push(unsub);
}

async function refreshPendingCount() {
  try {
    const snap = await getCountFromServer(query(collection(db, "reports"), where("status", "==", "pending")));
    setText("admin-metric-pending-reports", String(snap.data().count));
  } catch (error) {
    console.error("미처리 신고 카운트 실패", error);
  }
}

function reportMatchesTab(report) {
  const status = report.status || "pending";
  if (reportsTab === "pending") return status === "pending";
  if (reportsTab === "hold") return status === "hold";
  return status === "resolved" || status === "rejected";
}

function statusPillFor(status) {
  if (status === "pending") return '<span class="status-pill warning">미처리</span>';
  if (status === "hold") return '<span class="status-pill muted">보류</span>';
  if (status === "resolved") return '<span class="status-pill">처리 완료</span>';
  if (status === "rejected") return '<span class="status-pill muted">기각</span>';
  return `<span class="status-pill muted">${escapeHtml(status || "-")}</span>`;
}

function renderReportsTable() {
  const body = document.getElementById("admin-reports-body");
  if (!body) return;
  const rows = latestReports.filter(reportMatchesTab);

  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="7">해당 상태의 신고가 없습니다.</td></tr>';
    return;
  }

  body.innerHTML = rows
    .map((report) => {
      const snapshotText = report.messageSnapshot?.text || "";
      return `<tr data-report-row="${report.id}">
        <td>${escapeHtml(report.reason || "-")}</td>
        <td>${escapeHtml(report.roomId || "-")}</td>
        <td>${escapeHtml(report.targetAnonymousId || "-")}</td>
        <td>${escapeHtml(truncate(snapshotText, 24))}</td>
        <td>${report.reportCount ?? 1}</td>
        <td>${statusPillFor(report.status)}</td>
        <td><button type="button" class="small-button" data-report-open="${report.id}">${report.id === selectedReportId ? "선택됨" : "검토"}</button></td>
      </tr>`;
    })
    .join("");

  body.querySelectorAll("[data-report-open]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedReportId = btn.getAttribute("data-report-open");
      renderReportsTable();
      renderReportDetail();
    });
  });
}

async function renderReportDetail() {
  const panel = document.getElementById("admin-report-detail-body");
  const heading = document.getElementById("admin-report-detail-status");
  if (!panel) return;

  const report = latestReports.find((r) => r.id === selectedReportId);
  if (!report) {
    panel.innerHTML = '<p class="muted-copy">왼쪽 목록에서 신고를 선택하면 상세 내용이 표시됩니다.</p>';
    if (heading) heading.textContent = "";
    return;
  }

  if (heading) heading.innerHTML = statusPillFor(report.status);

  const createdAt = formatTimestamp(report.messageSnapshot?.createdAt);

  panel.innerHTML = `
    <div class="detail-grid">
      <article class="detail-card">
        <h3>신고 대상 메시지</h3>
        <dl class="detail-list">
          <div><dt>메시지 ID</dt><dd>${escapeHtml(report.messageId || "-")}</dd></div>
          <div><dt>채팅방</dt><dd>${escapeHtml(report.messageSnapshot?.roomId || report.roomId || "-")}</dd></div>
          <div><dt>작성 시각</dt><dd>${createdAt}</dd></div>
          <div><dt>신고 당시 스냅샷</dt><dd>${escapeHtml(report.messageSnapshot?.text || "-")}</dd></div>
        </dl>
      </article>
      <article class="detail-card">
        <h3>대상 사용자</h3>
        <dl class="detail-list">
          <div><dt>익명 사용자 ID</dt><dd>${escapeHtml(report.targetAnonymousId || "-")}</dd></div>
          <div><dt>현재 닉네임</dt><dd>${escapeHtml(report.messageSnapshot?.nickname || "-")}</dd></div>
          <div><dt>받은 신고</dt><dd id="admin-report-target-report-count">불러오는 중…</dd></div>
          <div><dt>이전 조치</dt><dd id="admin-report-target-restrictions">불러오는 중…</dd></div>
        </dl>
      </article>
    </div>
    <div class="detail-grid">
      <article class="detail-card">
        <h3>처리 액션</h3>
        <div class="action-row wrap-actions">
          <button type="button" class="small-button" data-report-action="hide">메시지 숨김</button>
          <button type="button" class="small-button" data-report-action="hide_restrict">숨김 + 24시간 제한</button>
          <button type="button" class="small-button secondary-small" data-report-action="reject">기각</button>
          <button type="button" class="small-button secondary-small" data-report-action="hold">보류</button>
        </div>
        <p class="muted-copy">기각, 보류, 처리 완료 상태는 운영자 콘솔과 운영 로그에만 남기며 이용자에게 진행상황으로 표시하지 않습니다.</p>
      </article>
      <article class="detail-card">
        <h3>운영자 메모</h3>
        <textarea class="admin-textarea" id="admin-report-memo" placeholder="판단 근거와 처리 내용을 남깁니다."></textarea>
      </article>
    </div>
  `;

  panel.querySelectorAll("[data-report-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleReportAction(report, btn.getAttribute("data-report-action")));
  });

  if (report.targetAnonymousId) {
    getDocs(collection(db, "users", report.targetAnonymousId, "restrictions"))
      .then((snap) => {
        const el = document.getElementById("admin-report-target-restrictions");
        if (!el) return;
        el.textContent = snap.empty ? "이전 제한 이력 없음" : `${snap.size}건`;
      })
      .catch((error) => {
        console.error("제한 이력 조회 실패", error);
        const el = document.getElementById("admin-report-target-restrictions");
        if (el) el.textContent = "조회 실패";
      });

    getCountFromServer(query(collection(db, "reports"), where("targetAnonymousId", "==", report.targetAnonymousId)))
      .then((snap) => {
        const el = document.getElementById("admin-report-target-report-count");
        if (el) el.textContent = `총 ${snap.data().count}건`;
      })
      .catch((error) => {
        console.error("누적 신고 수 조회 실패", error);
        const el = document.getElementById("admin-report-target-report-count");
        if (el) el.textContent = "조회 실패";
      });
  }
}

async function handleReportAction(report, action) {
  const memo = document.getElementById("admin-report-memo")?.value.trim() || "";
  const buttons = document.querySelectorAll(`[data-report-action]`);
  buttons.forEach((b) => (b.disabled = true));

  try {
    if (action === "hide" || action === "hide_restrict") {
      await callApplyAdminAction({
        actionType: "hide_message",
        roomId: report.roomId,
        messageId: report.messageId,
        reason: report.reason || "",
      });
      if (action === "hide_restrict" && report.targetAnonymousId) {
        await callApplyUserRestriction({
          targetUserId: report.targetAnonymousId,
          reason: report.reason || "",
          memo,
          durationHours: 24,
        });
      }
      await callApplyAdminAction({
        actionType: "update_report_status",
        reportId: report.id,
        status: "resolved",
        operatorAction: action === "hide_restrict" ? "hidden_and_restricted" : "hidden",
        memo,
      });
    } else if (action === "reject") {
      await callApplyAdminAction({
        actionType: "update_report_status",
        reportId: report.id,
        status: "rejected",
        operatorAction: "dismissed",
        memo,
      });
    } else if (action === "hold") {
      await callApplyAdminAction({
        actionType: "update_report_status",
        reportId: report.id,
        status: "hold",
        operatorAction: "",
        memo,
      });
    }
  } catch (error) {
    alert("처리 실패: " + describeError(error));
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

// ---------------------------------------------------------------------------
// Operation log
// ---------------------------------------------------------------------------

function watchOperationLogs() {
  const q = query(collection(db, "operationLogs"), orderBy("createdAt", "desc"), limit(LOGS_LIST_LIMIT));
  const unsub = onSnapshot(
    q,
    (snap) => {
      const list = document.getElementById("admin-log-list");
      if (!list) return;
      if (snap.empty) {
        list.innerHTML = "<li><span>운영 로그가 없습니다.</span></li>";
        return;
      }
      list.innerHTML = snap.docs
        .map((d) => {
          const log = d.data();
          const time = formatTimestamp(log.createdAt, true);
          const summary = `${log.operatorId ? shortenId(log.operatorId) : "operator"} · ${actionLabel(log.actionType)} · ${escapeHtml(log.reason || log.memo || "-")}`;
          return `<li><time>${time}</time><span>${summary}</span></li>`;
        })
        .join("");
    },
    (error) => {
      console.error("operationLogs 구독 실패", error);
      renderListError("admin-log-list", error);
    }
  );
  activeUnsubscribers.push(unsub);
}

function actionLabel(actionType) {
  const map = {
    hide_message: "메시지 숨김",
    unhide_message: "메시지 숨김 해제",
    close_room: "방 종료",
    reopen_room: "방 재개",
    set_room_push_policy: "푸시 정책 변경",
    update_report_status: "신고 상태 변경",
    add_banned_word: "금칙어 추가",
    remove_banned_word: "금칙어 삭제",
    apply_user_restriction: "사용자 제한",
  };
  return map[actionType] || actionType || "-";
}

// ---------------------------------------------------------------------------
// Banned words
// ---------------------------------------------------------------------------

function watchBannedWords() {
  const q = query(collection(db, "bannedWords"), orderBy("createdAt", "desc"));
  const unsub = onSnapshot(
    q,
    (snap) => {
      const list = document.getElementById("admin-word-list");
      if (!list) return;
      if (snap.empty) {
        list.innerHTML = "<li><span>등록된 금칙어가 없습니다.</span></li>";
        return;
      }
      list.innerHTML = snap.docs
        .map((d) => {
          const word = d.data();
          return `<li>
            <strong>${escapeHtml(word.expression || "-")}</strong>
            <span>${escapeHtml(word.category || "-")}</span>
            <div class="action-row admin-inline-actions">
              <button type="button" class="small-button secondary-small" data-word-remove="${d.id}">삭제</button>
            </div>
          </li>`;
        })
        .join("");

      list.querySelectorAll("[data-word-remove]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm("이 금칙어를 삭제할까요?")) return;
          btn.disabled = true;
          try {
            await callManageBannedWord({ op: "remove", wordId: btn.getAttribute("data-word-remove") });
          } catch (error) {
            alert("금칙어 삭제 실패: " + describeError(error));
            btn.disabled = false;
          }
        });
      });
    },
    (error) => {
      console.error("bannedWords 구독 실패", error);
      renderListError("admin-word-list", error);
    }
  );
  activeUnsubscribers.push(unsub);
}

// ---------------------------------------------------------------------------
// 유틸리티
// ---------------------------------------------------------------------------

function renderListError(elementId, error, isTableBody) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const message = "데이터를 불러오지 못했습니다: " + describeError(error);
  el.innerHTML = isTableBody ? `<tr><td colspan="7">${escapeHtml(message)}</td></tr>` : `<li><span>${escapeHtml(message)}</span></li>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function truncate(value, max) {
  const str = String(value ?? "");
  return str.length > max ? str.slice(0, max) + "…" : str;
}

function shortenId(id) {
  return String(id ?? "").slice(0, 8);
}

function formatTimestamp(ts, timeOnly) {
  if (!ts) return "-";
  const date = typeof ts.toDate === "function" ? ts.toDate() : new Date(ts);
  if (Number.isNaN(date.getTime())) return "-";
  if (timeOnly) {
    return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return date.toLocaleString("ko-KR", { hour12: false });
}

function formatCount(value) {
  return (typeof value === "number" ? value : 0).toLocaleString("ko-KR");
}
