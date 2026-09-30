/* global document, window */
document.documentElement.classList.add("js");
const menuButton = document.querySelector("[data-menu]");
const navigation = document.querySelector("#primary-navigation");
const narrow = window.matchMedia("(max-width: 980px)");

function closeMenu(restoreFocus = false) {
  menuButton.setAttribute("aria-expanded", "false");
  navigation.dataset.open = "false";
  if (restoreFocus) menuButton.focus();
}

menuButton.addEventListener("click", () => {
  const open = menuButton.getAttribute("aria-expanded") !== "true";
  menuButton.setAttribute("aria-expanded", String(open));
  navigation.dataset.open = String(open);
  if (open) navigation.querySelector("a").focus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menuButton.getAttribute("aria-expanded") === "true") closeMenu(true);
});
narrow.addEventListener("change", () => closeMenu());
document.querySelector(".skip-link").addEventListener("click", () => closeMenu());

for (const button of document.querySelectorAll("[data-copy]")) {
  button.hidden = false;
  button.addEventListener("click", async () => {
    const status = document.querySelector("#copy-status");
    const text = document.getElementById(button.dataset.copy).textContent;
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = `${button.dataset.label} copied.`;
    } catch {
      status.textContent = "Copy was unavailable. Select the commands and copy them manually.";
    }
  });
}
