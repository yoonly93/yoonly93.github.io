// 실검톡 랜딩 페이지 — 앱과 동일한 Firestore 데이터를 그대로 읽어 실시간 검색어
// 1위~10위를 보여주고, 오른쪽 채팅창에서 실제로 대화에 참여할 수 있게 한다.
// 읽기(rooms/messages/trends)는 firestore.rules상 공개 읽기라 로그인 없이 구독하고,
// 쓰기(메시지 전송/신고)는 앱과 동일한 sendMessage/submitReport 콜러블을 익명 인증으로
// 호출한다(admin.js의 익명 채팅 패턴과 동일).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getFirestore,
  doc,
  collection,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
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
const MAX_RANK = 10;
const NICKNAME_STORAGE_KEY = "buzztalk_web_nickname";
const AGE_CONFIRM_STORAGE_KEY = "buzztalk_web_age_confirmed";

const NICKNAME_ADJECTIVES = [
  "파란", "빨간", "노란", "초록", "보라", "하얀", "까만", "분홍", "주황",
  "조용한", "행복한", "용감한", "엉뚱한", "씩씩한", "다정한", "느긋한", "상큼한", "포근한", "수줍은",
];
const NICKNAME_NOUNS = [
  "여우", "고양이", "강아지", "판다", "토끼", "사자", "호랑이",
  "다람쥐", "고래", "펭귄", "너구리", "수달", "오리", "늑대", "사슴", "햄스터", "고슴도치",
];

const REPORT_REASONS = [
  "욕설·비방·괴롭힘",
  "혐오·차별",
  "성적·음란 콘텐츠",
  "개인정보 노출",
  "광고·스팸",
  "불법·위험한 콘텐츠",
  "권리 침해",
  "기타",
];

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const chatApp = initializeApp(firebaseConfig, "web-chat");
const chatAuth = getAuth(chatApp);
const chatFunctions = getFunctions(chatApp, FUNCTIONS_REGION);
const callSendMessage = httpsCallable(chatFunctions, "sendMessage");
const callSyncNickname = httpsCallable(chatFunctions, "syncNickname");
const callSubmitReport = httpsCallable(chatFunctions, "submitReport");

const listEl = document.getElementById("trend-live-list");
const updatedTextEl = document.getElementById("trend-updated-text");
const updatedBtn = document.getElementById("trend-updated-btn");
const layoutEl = document.querySelector(".trend-chat-layout");
const chatRankEl = document.getElementById("chat-panel-rank");
const chatTitleEl = document.getElementById("chat-panel-title");
const chatBackBtn = document.getElementById("chat-panel-back");
const chatShareBtn = document.getElementById("chat-panel-share");
const chatMessagesEl = document.getElementById("chat-messages");
const chatFooterEl = document.getElementById("chat-panel-footer");

let latestRooms = [];
const chatPreviewByRoomId = new Map();
const messageUnsubByRoomId = new Map();

let selectedRoomId = null;
let latestMessages = [];
let messagesUnsub = null;
const reportedMessageIds = new Set();

// 모바일에서는 실검 리스트와 채팅창을 같은 화면에 나란히 두지 않고, 대화를 누르면
// 채팅창이 전체 화면 페이지처럼 열리고 뒤로가기로 리스트 화면으로 돌아온다.
// 공유 시 앱과 동일한 https://buzztalk.posiki.com/room/<roomId> 형태 링크를
// 쓰기 때문에, 그 링크로 들어온 방문자는 곧장 이 채팅 페이지로 딥링크된다.
const mobileMedia = window.matchMedia("(max-width: 760px)");
const SHARE_BASE_URL = "https://buzztalk.posiki.com";
const deepLinkRoomId = readDeepLinkRoomId();

function readDeepLinkRoomId() {
  const fromQuery = new URLSearchParams(location.search).get("room");
  if (fromQuery) return fromQuery;
  const match = location.pathname.match(/\/room\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function isMobileLayout() {
  return mobileMedia.matches;
}

function showChatPage() {
  layoutEl?.classList.add("is-chat-open");
  document.documentElement.classList.add("chat-page-open");
}

function hideChatPage() {
  layoutEl?.classList.remove("is-chat-open");
  document.documentElement.classList.remove("chat-page-open");
}

// 딥링크로 곧장 들어와 채팅 페이지 state를 replaceState한 경우엔 그 이전에
// 리스트 페이지 히스토리가 없으므로, 뒤로가기 버튼을 누르면 사이트를 벗어나지 않고
// 리스트 화면으로만 전환한다. pushState로 들어온 경우에만 실제 history.back()을 쓴다.
let chatPageWasPushed = false;

function navigateToRoomPage(roomId) {
  if (!isMobileLayout()) return;
  showChatPage();
  chatPageWasPushed = true;
  history.pushState({ buzztalkRoomPage: true }, "", `${location.pathname}?room=${encodeURIComponent(roomId)}`);
}

chatBackBtn?.addEventListener("click", () => {
  if (chatPageWasPushed && history.state?.buzztalkRoomPage) {
    history.back();
  } else {
    hideChatPage();
    history.replaceState({}, "", location.pathname);
  }
});

window.addEventListener("popstate", (event) => {
  if (event.state?.buzztalkRoomPage) {
    showChatPage();
  } else {
    hideChatPage();
  }
});

chatShareBtn?.addEventListener("click", async () => {
  if (!selectedRoomId) return;
  const room = currentRoom();
  const shareUrl = `${SHARE_BASE_URL}/room/${encodeURIComponent(selectedRoomId)}`;
  const title = room?.keywordText ? `실검톡 '${room.keywordText}' 채팅방` : "실검톡 채팅방";
  if (navigator.share) {
    try {
      await navigator.share({ title, url: shareUrl });
    } catch (_err) {
      // 사용자가 공유 시트를 취소한 경우 등은 별도 처리하지 않는다.
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(shareUrl);
    showAppToast("채팅방 링크를 복사했습니다");
  } catch (_err) {
    showAppToast("링크 복사에 실패했습니다");
  }
});

let currentUid = null;
let currentNickname = null;
let identityReady = null;

function formatUpdateTime(value) {
  const date = value && typeof value.toDate === "function" ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatMessageTime(value) {
  const date = value && typeof value.toDate === "function" ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
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

let appToastTimer = null;
function showAppToast(message) {
  let toast = document.getElementById("app-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "app-toast";
    toast.className = "app-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(appToastTimer);
  appToastTimer = setTimeout(() => toast.classList.remove("is-visible"), 1800);
}

function topTrendRooms() {
  return latestRooms
    .filter((room) => Number.isFinite(Number(room.rank)) && Number(room.rank) >= 1 && Number(room.rank) <= MAX_RANK)
    .sort((a, b) => Number(a.rank) - Number(b.rank))
    .slice(0, MAX_RANK);
}

function watchTrendUpdatedAt() {
  onSnapshot(
    doc(db, "trends", "latest"),
    (snap) => {
      const iso = snap.data()?.collectedAtIso;
      if (!updatedTextEl) return;
      const time = iso ? formatUpdateTime(iso) : "";
      updatedTextEl.textContent = time ? `${time} 업데이트` : "업데이트 정보 없음";
    },
    () => {
      if (updatedTextEl) updatedTextEl.textContent = "업데이트 정보 없음";
    }
  );
}

function watchTrendRooms() {
  const q = query(collection(db, "rooms"), where("state", "==", "active"), limit(200));
  onSnapshot(
    q,
    (snap) => {
      latestRooms = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      syncChatPreviewSubscriptions();
      renderTrendList();

      if (!selectedRoomId) {
        const targetId = deepLinkRoomId || topTrendRooms()[0]?.id;
        if (targetId) {
          selectRoom(targetId);
          if (deepLinkRoomId && isMobileLayout()) {
            showChatPage();
            history.replaceState({ buzztalkRoomPage: true }, "", `${location.pathname}${location.search}`);
          }
        }
      } else {
        renderChatHeader();
      }
    },
    () => {
      if (listEl) {
        listEl.innerHTML = '<li class="trend-row-empty">실시간 검색어를 불러오지 못했습니다.</li>';
      }
    }
  );
}

// 상위 10개 방에 대해서만 마지막 메시지를 구독하고, 순위 밖으로 밀려난 방의
// 리스너는 즉시 해제한다(구독이 계속 쌓이지 않도록).
function syncChatPreviewSubscriptions() {
  const activeIds = new Set(topTrendRooms().map((room) => room.id));

  messageUnsubByRoomId.forEach((unsub, roomId) => {
    if (!activeIds.has(roomId)) {
      unsub();
      messageUnsubByRoomId.delete(roomId);
      chatPreviewByRoomId.delete(roomId);
    }
  });

  activeIds.forEach((roomId) => {
    if (messageUnsubByRoomId.has(roomId)) return;
    const unsub = onSnapshot(
      query(collection(db, "rooms", roomId, "messages"), orderBy("createdAt", "desc"), limit(1)),
      (snap) => {
        const docSnap = snap.docs[0];
        const data = docSnap?.data();
        if (!data || data.hidden === true || data.deleted === true) {
          chatPreviewByRoomId.delete(roomId);
        } else {
          chatPreviewByRoomId.set(roomId, String(data.text ?? data.body ?? ""));
        }
        renderTrendList();
      },
      () => {
        chatPreviewByRoomId.delete(roomId);
      }
    );
    messageUnsubByRoomId.set(roomId, unsub);
  });
}

function renderTrendList() {
  if (!listEl) return;
  const rooms = topTrendRooms();
  if (rooms.length === 0) {
    listEl.innerHTML = '<li class="trend-row-empty">현재 표시할 실시간 검색어가 없습니다.</li>';
    return;
  }

  listEl.innerHTML = rooms
    .map((room) => {
      const rank = Number(room.rank);
      const keyword = room.keywordText || room.id;
      const newsTitle = Array.isArray(room.newsLinks)
        ? room.newsLinks.find((link) => link && typeof link.title === "string" && link.title)?.title
        : null;
      const chatPreview = chatPreviewByRoomId.get(room.id);
      const isSelected = room.id === selectedRoomId;

      return `<li class="trend-row${isSelected ? " is-selected" : ""}" data-room-id="${escapeHtml(room.id)}">
        <span class="trend-rank" data-rank="${rank}">${rank}</span>
        <div class="trend-body">
          <div class="trend-title">${escapeHtml(keyword)}</div>
          ${newsTitle ? `<button type="button" class="trend-preview" data-app-toast>${escapeHtml(newsTitle)}</button>` : ""}
          ${chatPreview ? `<button type="button" class="trend-preview trend-preview-chat" data-select-room="${escapeHtml(room.id)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/></svg><span>${escapeHtml(chatPreview)}</span></button>` : ""}
        </div>
        <button type="button" class="trend-chat-button" data-select-room="${escapeHtml(room.id)}" aria-label="${escapeHtml(keyword)} 채팅 보기">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5A8.48 8.48 0 0 1 21 11v.5Z"/></svg>
        </button>
      </li>`;
    })
    .join("");
}

updatedBtn?.addEventListener("click", () => {
  listEl?.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

listEl?.addEventListener("click", (event) => {
  const toastTarget = event.target.closest("[data-app-toast]");
  if (toastTarget) {
    showAppToast("앱에서 확인하세요!");
    return;
  }
  const selectTarget = event.target.closest("[data-select-room]");
  if (selectTarget) {
    const roomId = selectTarget.getAttribute("data-select-room");
    selectRoom(roomId);
    navigateToRoomPage(roomId);
  }
});

// ---------------------------------------------------------------------------
// 채팅 참여: 익명 인증 + 닉네임
// ---------------------------------------------------------------------------

function generateRandomNickname() {
  const adjective = NICKNAME_ADJECTIVES[Math.floor(Math.random() * NICKNAME_ADJECTIVES.length)];
  const noun = NICKNAME_NOUNS[Math.floor(Math.random() * NICKNAME_NOUNS.length)];
  return `${adjective} ${noun}`;
}

// 앱과 동일하게 uid당 닉네임을 한 번만 정하고 계속 재사용한다(익명 인증은
// 브라우저에 로컬 저장되므로 재방문해도 같은 uid → 같은 닉네임 유지).
function ensureChatIdentity() {
  if (identityReady) return identityReady;
  identityReady = (async () => {
    if (!chatAuth.currentUser) {
      await signInAnonymously(chatAuth);
    }
    currentUid = chatAuth.currentUser.uid;

    const stored = localStorage.getItem(NICKNAME_STORAGE_KEY);
    if (stored) {
      currentNickname = stored;
      renderMessages();
      return;
    }

    const candidate = generateRandomNickname();
    try {
      const result = await callSyncNickname({ nickname: candidate });
      currentNickname = result.data?.nickname || candidate;
    } catch (_err) {
      currentNickname = candidate;
    }
    localStorage.setItem(NICKNAME_STORAGE_KEY, currentNickname);
    renderMessages();
  })();
  return identityReady;
}

ensureChatIdentity();

// ---------------------------------------------------------------------------
// 채팅창: 방 선택 / 메시지 구독 / 렌더링
// ---------------------------------------------------------------------------

function selectRoom(roomId) {
  if (!roomId || roomId === selectedRoomId) return;
  selectedRoomId = roomId;
  latestMessages = [];
  reportedMessageIds.clear();

  if (messagesUnsub) {
    messagesUnsub();
    messagesUnsub = null;
  }

  renderTrendList();
  renderChatHeader();
  if (chatMessagesEl) {
    chatMessagesEl.innerHTML = '<p class="chat-messages-empty">채팅을 불러오는 중입니다.</p>';
  }
  renderComposer();

  messagesUnsub = onSnapshot(
    query(collection(db, "rooms", roomId, "messages"), orderBy("createdAt", "asc")),
    (snap) => {
      latestMessages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderMessages();
    },
    () => {
      if (chatMessagesEl) {
        chatMessagesEl.innerHTML = '<p class="chat-messages-empty">채팅을 불러오지 못했습니다.</p>';
      }
    }
  );
}

function currentRoom() {
  return latestRooms.find((room) => room.id === selectedRoomId) || null;
}

function renderChatHeader() {
  const room = currentRoom();
  if (!room) return;
  if (chatRankEl) chatRankEl.textContent = "";
  if (chatTitleEl) chatTitleEl.textContent = room.keywordText || room.id;
  renderComposer();
}

function shouldShowAdAfter(messageNumber) {
  return messageNumber === 5 || (messageNumber > 5 && (messageNumber - 5) % 10 === 0);
}

function renderMessages() {
  if (!chatMessagesEl) return;
  const room = currentRoom();

  const parts = [];

  if (room?.category && ["crime", "celebrity", "politics", "economy"].includes(room.category)) {
    parts.push(`<div class="chat-vote-bubble" data-app-toast>
      <span class="chat-message-nickname">투표봇</span>
      <p class="chat-vote-body">이 화제에 대해 어떻게 생각하세요?</p>
      <div class="chat-vote-actions">
        <button type="button" class="chat-vote-btn chat-vote-btn-like" data-app-toast>
          <span>좋아요</span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>
        </button>
        <button type="button" class="chat-vote-btn chat-vote-btn-dislike" data-app-toast>
          <span>별로에요</span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>
        </button>
      </div>
    </div>`);
  }

  if (latestMessages.length === 0) {
    parts.push('<p class="chat-messages-empty">아직 메시지가 없습니다. 첫 메시지를 남겨보세요!</p>');
  } else {
    latestMessages.forEach((message, index) => {
      const mine = currentUid && message.anonymousUserId === currentUid;
      const hidden = message.hidden === true;
      const body = hidden ? "운영정책에 따라 숨겨진 메시지입니다" : (message.text || message.body || "");
      const nickname = message.nicknameSnapshot || message.nickname || "익명";
      const time = formatMessageTime(message.createdAt);
      const alreadyReported = reportedMessageIds.has(message.id);

      parts.push(`<div class="chat-message${mine ? " chat-message-mine" : ""}">
        <span class="chat-message-nickname">${escapeHtml(nickname)}</span>
        <div class="chat-message-bubble">
          <p class="chat-message-body">${escapeHtml(body)}</p>
        </div>
        <div class="chat-message-meta">
          <span class="chat-message-time">${time}</span>
          ${!mine && !hidden ? renderReportControl(message.id, alreadyReported) : ""}
        </div>
      </div>`);

      if (shouldShowAdAfter(index + 1)) {
        parts.push(`<div class="chat-ad-bubble" data-app-toast>
          <span class="chat-ad-badge">광고</span>
          <p class="chat-ad-title">실검톡 앱에서 더 많은 이야기를 만나보세요</p>
          <p class="chat-ad-body">지금 뜨는 검색어를 앱에서 실시간으로 확인해보세요.</p>
        </div>`);
      }
    });
  }

  chatMessagesEl.innerHTML = parts.join("");
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function renderReportControl(messageId, alreadyReported) {
  if (alreadyReported) {
    return '<span class="chat-report-done">신고했습니다</span>';
  }
  return `<button type="button" class="chat-report-btn" data-report-toggle="${escapeHtml(messageId)}">신고</button>`;
}

chatMessagesEl?.addEventListener("click", async (event) => {
  const toastTarget = event.target.closest("[data-app-toast]");
  if (toastTarget) {
    showAppToast("앱에서 확인하세요!");
    return;
  }

  const reportToggle = event.target.closest("[data-report-toggle]");
  if (reportToggle) {
    openReportForm(reportToggle);
    return;
  }

  const reportSubmit = event.target.closest("[data-report-submit]");
  if (reportSubmit) {
    await submitReport(reportSubmit);
  }
});

function openReportForm(button) {
  const messageId = button.getAttribute("data-report-toggle");
  const meta = button.closest(".chat-message-meta");
  if (!meta || meta.querySelector(".chat-report-form")) return;

  const form = document.createElement("div");
  form.className = "chat-report-form";
  form.innerHTML = `
    <select aria-label="신고 사유 선택">
      ${REPORT_REASONS.map((reason) => `<option value="${escapeHtml(reason)}">${escapeHtml(reason)}</option>`).join("")}
    </select>
    <button type="button" class="chat-report-submit" data-report-submit="${escapeHtml(messageId)}">제출</button>
  `;
  button.replaceWith(form);
}

async function submitReport(button) {
  const messageId = button.getAttribute("data-report-submit");
  const select = button.previousElementSibling;
  const reason = select?.value || REPORT_REASONS[REPORT_REASONS.length - 1];
  if (!selectedRoomId || !messageId) return;

  button.disabled = true;
  try {
    await ensureChatIdentity();
    await callSubmitReport({ roomId: selectedRoomId, messageId, reason });
    reportedMessageIds.add(messageId);
    renderMessages();
  } catch (error) {
    showAppToast(error?.message || "신고에 실패했습니다.");
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 입력창: 연령 자기선언 게이트 → 실제 메시지 입력
// ---------------------------------------------------------------------------

function renderComposer() {
  if (!chatFooterEl) return;
  const room = currentRoom();
  const canSendToRoom = !room || room.state === "active" || room.state === "archived";

  if (!canSendToRoom) {
    chatFooterEl.innerHTML = '<p class="chat-composer-disabled">종료된 대화입니다. 메시지를 보낼 수 없습니다.</p>';
    return;
  }

  const ageConfirmed = localStorage.getItem(AGE_CONFIRM_STORAGE_KEY) === "1";
  if (!ageConfirmed) {
    chatFooterEl.innerHTML = `
      <div class="chat-age-gate">
        <label><input type="checkbox" id="chat-age-checkbox"> 만 14세 이상입니다</label>
        <button type="button" id="chat-age-confirm">채팅 참여하기</button>
      </div>
    `;
    const checkbox = document.getElementById("chat-age-checkbox");
    const confirmBtn = document.getElementById("chat-age-confirm");
    checkbox?.addEventListener("change", () => {
      confirmBtn?.classList.toggle("is-enabled", checkbox.checked);
    });
    confirmBtn?.addEventListener("click", () => {
      if (!checkbox?.checked) return;
      localStorage.setItem(AGE_CONFIRM_STORAGE_KEY, "1");
      renderComposer();
    });
    return;
  }

  chatFooterEl.innerHTML = `
    <div class="chat-composer">
      <textarea class="chat-composer-input" id="chat-composer-input" placeholder="메시지 입력" rows="1"></textarea>
      <button type="button" class="chat-composer-send" id="chat-composer-send" aria-label="메시지 보내기">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 9-18 9 4-9-4-9Z"/><path d="M7 12h11"/></svg>
      </button>
    </div>
  `;

  const input = document.getElementById("chat-composer-input");
  const sendBtn = document.getElementById("chat-composer-send");

  function updateSendState() {
    const hasText = Boolean(input?.value.trim());
    sendBtn?.classList.toggle("is-active", hasText);
  }

  input?.addEventListener("input", updateSendState);
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  });
  sendBtn?.addEventListener("click", handleSend);

  async function handleSend() {
    const body = input?.value.trim();
    if (!body || !selectedRoomId) return;
    sendBtn.disabled = true;
    input.disabled = true;
    try {
      await ensureChatIdentity();
      await callSendMessage({
        roomId: selectedRoomId,
        body,
        nickname: currentNickname,
        platform: "web",
      });
      input.value = "";
    } catch (error) {
      showAppToast(error?.message || "메시지 전송에 실패했습니다.");
    } finally {
      sendBtn.disabled = false;
      input.disabled = false;
      updateSendState();
      input?.focus();
    }
  }
}

watchTrendUpdatedAt();
watchTrendRooms();
