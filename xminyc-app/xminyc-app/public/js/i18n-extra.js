// Дополнительные строки (ru/en). Для остальных языков работает откат на русский.
Object.assign(window.I18N.dict.ru, {
  history: 'История', history_empty: 'Вы пока ничего не слушали', history_clear: 'Очистить историю',
  admin_panel: 'Админ-панель', karaoke: 'Караоке', karaoke_hint: 'Нажмите на строку, чтобы перейти к ней',
  menu_filters: 'Поиск по фильтрам', filters: 'Фильтры', filter_key: 'Тональность', filter_genre: 'Жанр', filter_lang: 'Язык',
  filter_type: 'Тип', filter_all: 'Все', filter_reset: 'Сбросить', filter_hint: 'Введите запрос или выберите фильтры',
  forgot_password: 'Забыли пароль?', forgot_title: 'Восстановление пароля', forgot_ph: 'Email аккаунта', forgot_send: 'Отправить ссылку',
  back_to_login: 'Вернуться ко входу',
  reset_title: 'Новый пароль', reset_new: 'Новый пароль (минимум 8 символов)', reset_save: 'Сохранить пароль', reset_done: 'Пароль изменён. Теперь войдите с новым паролем.',
  verify_notice: 'Email не подтверждён. Мы отправили письмо со ссылкой — проверьте почту.', verify_resend: 'Отправить письмо ещё раз', verify_sent: 'Письмо отправлено',
  verify_ok: 'Email подтверждён. Спасибо!', verify_fail: 'Ссылка подтверждения недействительна или устарела.',
  lrc_label: 'Синхронизированный текст (LRC)', lrc_hint: 'Формат: [мм:сс.xx] строка текста (можно загрузить и .srt)', lrc_load: 'Загрузить .lrc / .srt',
  key_now: 'Тональность', terms: 'Правила', copyright: 'Правообладателям', footer_copy: 'Минусовки. Все права принадлежат их владельцам.',
  report_copyright: 'Нарушение авторских прав'
});
Object.assign(window.I18N.dict.en, {
  history: 'History', history_empty: 'You have not played anything yet', history_clear: 'Clear history',
  admin_panel: 'Admin panel', karaoke: 'Karaoke', karaoke_hint: 'Click a line to jump to it',
  menu_filters: 'Search by filters', filters: 'Filters', filter_key: 'Key', filter_genre: 'Genre', filter_lang: 'Language',
  filter_type: 'Type', filter_all: 'All', filter_reset: 'Reset', filter_hint: 'Enter a query or pick filters',
  forgot_password: 'Forgot password?', forgot_title: 'Password recovery', forgot_ph: 'Account email', forgot_send: 'Send link',
  back_to_login: 'Back to sign in',
  reset_title: 'New password', reset_new: 'New password (at least 8 characters)', reset_save: 'Save password', reset_done: 'Password changed. Please sign in with the new password.',
  verify_notice: 'Email is not verified. We sent a message with a link — check your inbox.', verify_resend: 'Resend email', verify_sent: 'Email sent',
  verify_ok: 'Email verified. Thank you!', verify_fail: 'The verification link is invalid or expired.',
  lrc_label: 'Synced lyrics (LRC)', lrc_hint: 'Format: [mm:ss.xx] lyric line', lrc_load: 'Load .lrc / .srt',
  key_now: 'Key', terms: 'Terms', copyright: 'Copyright holders', footer_copy: 'Backing tracks. All rights belong to their owners.',
  report_copyright: 'Copyright infringement'
});