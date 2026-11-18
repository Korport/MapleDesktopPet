const notificationBanner = document.getElementById('notification');
const stopNotifications = window.mascot.onNotification((notification) => {
  if (!notification) {
    notificationBanner.classList.add('hidden');
    return;
  }
  document.getElementById('notification-text').textContent = notification.text;
  notificationBanner.classList.remove('hidden');
  if (!busy) Sprite.setState(notification.source === 'email' ? 'email_alert' : 'teams_alert');
});
document.getElementById('notification-dismiss').addEventListener('click', () => {
  notificationBanner.classList.add('hidden');
});
window.addEventListener('beforeunload', stopNotifications, { once: true });
