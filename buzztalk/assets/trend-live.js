// 실검톡 랜딩 페이지 — 앱과 동일한 Firestore 데이터를 그대로 읽어 실시간 검색어
// 1위~10위를 보여준다. rooms/trends 컬렉션은 firestore.rules에서 공개 읽기
// (`allow read: if true`)이므로 로그인 없이 브라우저에서 바로 구독할 수 있다.
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

const firebaseConfig = {
  apiKey: "AIzaSyD2xYw8zSB3jVILUFCZfdcmdQRSCfOtJgM",
  authDomain: "buzztalk-yoonly93.firebaseapp.com",
  projectId: "buzztalk-yoonly93",
  storageBucket: "buzztalk-yoonly93.firebasestorage.app",
  messagingSenderId: "648177060118",
  appId: "1:648177060118:web:1a37d88eb667ba9b48a837",
};

const MAX_RANK = 10;

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const listEl = document.getElementById("trend-live-list");
const updatedTextEl = document.getElementById("trend-updated-text");
const updatedBtn = document.getElementById("trend-updated-btn");

let latestRooms = [];
const chatPreviewByRoomId = new Map();
const messageUnsubByRoomId = new Map();

function formatUpdateTime(value) {
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

      return `<li class="trend-row" data-room-id="${escapeHtml(room.id)}">
        <span class="trend-rank" data-rank="${rank}">${rank}</span>
        <div class="trend-body">
          <div class="trend-title">${escapeHtml(keyword)}</div>
          ${newsTitle ? `<button type="button" class="trend-preview" data-app-toast>${escapeHtml(newsTitle)}</button>` : ""}
          ${chatPreview ? `<button type="button" class="trend-preview trend-preview-chat" data-app-toast><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/></svg><span>${escapeHtml(chatPreview)}</span></button>` : ""}
        </div>
        <button type="button" class="trend-chat-button" data-app-toast aria-label="${escapeHtml(keyword)} 채팅 보기">
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
  if (event.target.closest("[data-app-toast]")) {
    showAppToast("앱에서 확인하세요!");
  }
});

watchTrendUpdatedAt();
watchTrendRooms();
