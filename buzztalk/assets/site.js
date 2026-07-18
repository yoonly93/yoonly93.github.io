const WEB3FORMS_ACCESS_KEY = "d20e654a-d834-4c45-8493-c391629252f5";
const CONTACT_DESTINATION_EMAIL = "contact@posiki.com";
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

function showFormBanner(banner, kind, message) {
  banner.hidden = false;
  banner.className = `form-banner ${kind}`;
  banner.textContent = message;
}

function handleContactSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const banner = form.parentElement.querySelector("[data-form-banner]");
  const submitButton = form.querySelector("[data-submit-button]");

  const type = form.elements.type.value;
  const replyTo = form.elements.replyTo.value.trim();
  const subject = form.elements.subject.value.trim();
  const appVersion = form.elements.appVersion.value.trim();
  const device = form.elements.device.value.trim();
  const body = form.elements.body.value.trim();

  if (!subject || !body) {
    showFormBanner(banner, "error", "제목과 내용은 필수 입력입니다.");
    return;
  }

  const payload = {
    access_key: WEB3FORMS_ACCESS_KEY,
    subject: `[실검톡 문의] ${type} - ${subject}`,
    from_name: "실검톡 BuzzTalk 문의",
    email: replyTo || CONTACT_DESTINATION_EMAIL,
    inquiry_type: type,
    reply_to: replyTo || "미입력",
    app_version: appVersion || "미입력",
    device: device || "미입력",
    message: body,
  };

  submitButton.disabled = true;
  submitButton.textContent = "보내는 중...";
  banner.hidden = true;

  fetch("https://api.web3forms.com/submit", {
    method: "POST",
    headers: {"Content-Type": "application/json", Accept: "application/json"},
    body: JSON.stringify(payload),
  })
    .then(response => response.json())
    .then(data => {
      if (data.success) {
        showFormBanner(banner, "success", "문의가 접수되었습니다. 감사합니다.");
        form.reset();
      } else {
        showFormBanner(banner, "error", "전송에 실패했습니다. 잠시 후 다시 시도해주세요.");
      }
    })
    .catch(() => {
      showFormBanner(banner, "error", "전송에 실패했습니다. 잠시 후 다시 시도해주세요.");
    })
    .finally(() => {
      submitButton.disabled = false;
      submitButton.textContent = "문의하기";
    });
}

document.addEventListener("DOMContentLoaded", () => {
  setupStoreLinks();
  const contactForm = document.querySelector("[data-contact-form]");
  if (contactForm) {
    contactForm.addEventListener("submit", handleContactSubmit);
  }
});
