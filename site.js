const feedback = document.querySelector("#copy-feedback");
let feedbackTimer;

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(button.dataset.copy);
      feedback.textContent = "تم نسخ بصمة الملف.";
    } catch {
      feedback.textContent =
        "تعذر النسخ التلقائي. افتح بصمة الملف وحددها لنسخها يدويًا.";
    }
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      feedback.textContent = "";
    }, 5000);
  });
});
