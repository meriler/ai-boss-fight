/* Подпись ЗАМОРОЖЕННОГО банка картинок (Codex-ревью 18.07, находка 6): sha256 по
 * отсортированным (id, class, role, sha256(файл ассета)) всех images банка.
 * Пилот головы гоняется на конкретном банке — фикстура parity-head-fixture.json несёт
 * эту подпись (frozen_images_sig), CI пересчитывает её по content/<банк>/ и падает при
 * любой подмене картинки/класса/роли: «замена картинок = красный флаг, эскалация
 * владельцу» (ТЗ-платформа-v3 §2.4; frozen-детект §1.3 реагирует именно на состав
 * картинок ролей, не на форму frozen_params). Node-only (fs/crypto) — в браузер не едет. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function bankImagesSig(bankDir) {
  const bank = JSON.parse(fs.readFileSync(path.join(bankDir, 'bank.json'), 'utf-8'));
  const rows = [...bank.images]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(img => {
      const file = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(bankDir, 'assets', img.src)))
        .digest('hex');
      return img.id + '|' + img.class + '|' + img.role + '|' + file;
    });
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 24);
}
