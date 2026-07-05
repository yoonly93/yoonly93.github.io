const CONTACT_EMAIL = "wildkindground@gmail.com";

function buildMailto(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const type = form.elements.type.value;
  const replyTo = form.elements.replyTo.value.trim();
  const appVersion = form.elements.appVersion.value.trim();
  const device = form.elements.device.value.trim();
  const body = form.elements.body.value.trim();

  const subject = `[실검톡 문의] ${type}`;
  const lines = [
    `문의 유형: ${type}`,
    `답변받을 이메일: ${replyTo || "미입력"}`,
    `앱 버전: ${appVersion || "미입력"}`,
    `기기/OS: ${device || "미입력"}`,
    "",
    "문의 내용:",
    body
  ];

  const url = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n"))}`;
  window.location.href = url;
}

document.addEventListener("DOMContentLoaded", () => {
  const contactForm = document.querySelector("[data-contact-form]");
  if (contactForm) {
    contactForm.addEventListener("submit", buildMailto);
  }
});
