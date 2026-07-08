const CONTACT_EMAIL = "wildkindground@gmail.com";
const IOS_STORE_URL = "";
const ANDROID_STORE_URL = "";

function userStoreUrl() {
  const platform = navigator.userAgent || "";
  if (/Android/i.test(platform)) {
    return ANDROID_STORE_URL;
  }
  if (/iPhone|iPad|iPod/i.test(platform)) {
    return IOS_STORE_URL;
  }
  return IOS_STORE_URL || ANDROID_STORE_URL;
}

function setupStoreLinks() {
  const storeActions = document.querySelector(".store-actions");
  const iosLink = document.querySelector("[data-ios-store]");
  const androidLink = document.querySelector("[data-android-store]");
  const hasIos = IOS_STORE_URL.length > 0;
  const hasAndroid = ANDROID_STORE_URL.length > 0;

  if (iosLink && hasIos) {
    iosLink.href = IOS_STORE_URL;
  }
  if (androidLink && hasAndroid) {
    androidLink.href = ANDROID_STORE_URL;
  }
  if (storeActions && (hasIos || hasAndroid)) {
    storeActions.hidden = false;
  }

  document.querySelectorAll("[data-store-route]").forEach(button => {
    button.addEventListener("click", () => {
      const url = userStoreUrl();
      if (url) {
        window.location.href = url;
      }
    });
  });
}

function buildMailto(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const type = form.elements.type.value;
  const customSubject = form.elements.subject.value.trim();
  const replyTo = form.elements.replyTo.value.trim();
  const appVersion = form.elements.appVersion.value.trim();
  const device = form.elements.device.value.trim();
  const occurredAt = form.elements.occurredAt.value.trim();
  const body = form.elements.body.value.trim();

  const subject = `[실검톡 문의] ${type}${customSubject ? ` - ${customSubject}` : ""}`;
  const lines = [
    `문의 유형: ${type}`,
    `제목: ${customSubject || "미입력"}`,
    `답변받을 이메일: ${replyTo || "미입력"}`,
    `앱 버전: ${appVersion || "미입력"}`,
    `기기/OS: ${device || "미입력"}`,
    `발생 시각: ${occurredAt || "미입력"}`,
    "",
    "민감한 개인정보는 문의 내용에 포함하지 마세요.",
    "",
    "문의 내용:",
    body
  ];

  const url = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n"))}`;
  window.location.href = url;
}

document.addEventListener("DOMContentLoaded", () => {
  setupStoreLinks();
  const contactForm = document.querySelector("[data-contact-form]");
  if (contactForm) {
    contactForm.addEventListener("submit", buildMailto);
  }
});
