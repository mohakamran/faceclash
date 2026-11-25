<?php
declare(strict_types=1);

const START_RATING = 0;   // everyone starts at 0; winners gain, losers drop
const K_FACTOR     = 32;

const SEED_NAMES = [
    'Aria', 'Blake', 'Casey', 'Dana', 'Eden', 'Finn', 'Gray', 'Harper', 'Indigo', 'Jules',
    'Kai', 'Lane', 'Morgan', 'Nova', 'Oakley', 'Parker', 'Quinn', 'Reese', 'Sage', 'Tatum',
    'Uma', 'Vale', 'Wren', 'Xen', 'Yael', 'Zion', 'Ash', 'Bryn', 'Cove', 'Drew',
];

function db(): PDO
{
    static $pdo = null;
    if ($pdo) return $pdo;

    $dir = __DIR__ . '/data';
    if (!is_dir($dir)) mkdir($dir, 0775, true);

    $pdo = new PDO('sqlite:' . $dir . '/hotornot.sqlite', null, null, [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA busy_timeout = 3000');

    $pdo->exec('CREATE TABLE IF NOT EXISTS people (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL,
        img        TEXT    NOT NULL UNIQUE,
        rating     REAL    NOT NULL DEFAULT ' . START_RATING . ',
        wins       INTEGER NOT NULL DEFAULT 0,
        losses     INTEGER NOT NULL DEFAULT 0,
        uploaded   INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    )');
    $pdo->exec('CREATE TABLE IF NOT EXISTS votes (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        winner INTEGER NOT NULL,
        loser  INTEGER NOT NULL,
        delta  REAL    NOT NULL,
        at     INTEGER NOT NULL,
        winner_after REAL,
        loser_after  REAL
    )');
    // Upgrade older databases in place.
    add_columns($pdo, 'votes',  ['winner_after' => 'REAL', 'loser_after' => 'REAL', 'ip_hash' => 'TEXT']);
    // status: active (in the game) | hidden (paused by admin) | pending (upload awaiting approval)
    add_columns($pdo, 'people', ['delete_hash' => 'TEXT', 'status' => "TEXT NOT NULL DEFAULT 'active'"]);
    $pdo->exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS votes_ip_at ON votes (ip_hash, at)');

    seed_faces($pdo);
    return $pdo;
}

const SETTING_DEFAULTS = [
    'roundsPerGame'   => 10,    // matchups before the results screen
    'uploadsOpen'     => true,  // show "Add yourself"
    'requireApproval' => false, // new uploads wait for an admin
];

function settings(PDO $pdo): array
{
    $out = SETTING_DEFAULTS;
    foreach ($pdo->query('SELECT key, value FROM settings') as $r) {
        if (array_key_exists($r['key'], $out)) $out[$r['key']] = json_decode($r['value'], true);
    }
    return $out;
}

function save_settings(PDO $pdo, array $in): array
{
    $cur = settings($pdo);
    if (isset($in['roundsPerGame']))   $cur['roundsPerGame']   = max(3, min(30, (int)$in['roundsPerGame']));
    if (isset($in['uploadsOpen']))     $cur['uploadsOpen']     = (bool)$in['uploadsOpen'];
    if (isset($in['requireApproval'])) $cur['requireApproval'] = (bool)$in['requireApproval'];
    $st = $pdo->prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    foreach ($cur as $k => $v) $st->execute([$k, json_encode($v)]);
    return $cur;
}

function add_columns(PDO $pdo, string $table, array $cols): void
{
    $have = array_column($pdo->query("PRAGMA table_info($table)")->fetchAll(), 'name');
    foreach ($cols as $c => $type) {
        if (!in_array($c, $have, true)) $pdo->exec("ALTER TABLE $table ADD COLUMN $c $type");
    }
}

/** Remove a face and its photo file (votes stay so others' score history is intact). */
function delete_person(PDO $pdo, int $id): bool
{
    $get = $pdo->prepare('SELECT img, uploaded FROM people WHERE id = ?');
    $get->execute([$id]);
    $row = $get->fetch();
    if (!$row) return false;
    $pdo->prepare('DELETE FROM people WHERE id = ?')->execute([$id]);
    if ((int)$row['uploaded'] >= 1) { // visitor (1) or admin (2) upload: delete the file
        @unlink(__DIR__ . '/uploads/' . basename($row['img']));
    } else {
        // A built-in face: remember the removal so seeding doesn't re-add it.
        $f = __DIR__ . '/data/removed_faces.json';
        $list = is_file($f) ? (json_decode((string)file_get_contents($f), true) ?: []) : [];
        $list[] = $row['img'];
        file_put_contents($f, json_encode(array_values(array_unique($list))));
    }
    return true;
}

/** Admin password lives hashed in data/admin.json (set with scripts/set_admin_password.php). */
function admin_hash(): ?string
{
    $f = __DIR__ . '/data/admin.json';
    if (!is_file($f)) return null;
    $j = json_decode((string)file_get_contents($f), true);
    return is_array($j) && !empty($j['hash']) ? $j['hash'] : null;
}

/** Salted hash of the visitor's IP, so rate limits work without storing raw IPs. */
function ip_hash(): string
{
    $f = __DIR__ . '/data/salt.txt';
    if (!is_file($f)) file_put_contents($f, bin2hex(random_bytes(16)));
    return substr(hash('sha256', trim((string)file_get_contents($f)) . ($_SERVER['REMOTE_ADDR'] ?? '')), 0, 32);
}

/** Register every image in faces/ (AI-generated, see scripts/fetch_faces.sh). */
function seed_faces(PDO $pdo): void
{
    $files = glob(__DIR__ . '/faces/*.jpg') ?: [];
    sort($files);
    $ins = $pdo->prepare('INSERT OR IGNORE INTO people (name, img, rating, created_at) VALUES (?, ?, ' . START_RATING . ', ?)');
    $removed = is_file(__DIR__ . '/data/removed_faces.json')
        ? (json_decode((string)file_get_contents(__DIR__ . '/data/removed_faces.json'), true) ?: []) : [];
    $have = array_flip($pdo->query("SELECT img FROM people WHERE img LIKE 'faces/%'")->fetchAll(PDO::FETCH_COLUMN));
    foreach ($files as $i => $f) {
        $img = 'faces/' . basename($f);
        if (isset($have[$img])) continue;                 // already registered
        if (in_array($img, $removed, true)) continue; // an admin removed it; don't bring it back
        $ins->execute([SEED_NAMES[$i % count(SEED_NAMES)], $img, time()]);
    }
}

/**
 * Tier ("level") a face has reached, from its score. Shown as a badge with icon + label.
 * New -> Cold / Warming up -> Hot -> On fire -> Legend
 */
const TIERS = [
    ['key' => 'legend', 'label' => 'Legend',     'icon' => '👑', 'min' => 100],
    ['key' => 'fire',   'label' => 'On fire',    'icon' => '🔥', 'min' => 50],
    ['key' => 'hot',    'label' => 'Hot',        'icon' => '🌶️', 'min' => 20],
    ['key' => 'warm',   'label' => 'Warming up', 'icon' => '☀️', 'min' => -20],
    ['key' => 'cold',   'label' => 'Cold',       'icon' => '❄️', 'min' => PHP_INT_MIN],
];

function tier(float $rating, int $votes): array
{
    if ($votes === 0) return ['key' => 'new', 'label' => 'New', 'icon' => '🆕', 'next' => TIERS[2]['min']];
    foreach (TIERS as $i => $t) {
        if ($rating >= $t['min']) {
            return ['key' => $t['key'], 'label' => $t['label'], 'icon' => $t['icon'], 'next' => $i > 0 ? TIERS[$i - 1]['min'] : null];
        }
    }
    return TIERS[4];
}

/** Public shape of a person row. */
function person(array $r): array
{
    $votes = (int)$r['wins'] + (int)$r['losses'];
    return [
        'id'      => (int)$r['id'],
        'name'    => $r['name'],
        'img'     => $r['img'],
        'rating'  => (int)round((float)$r['rating']),
        'wins'    => (int)$r['wins'],
        'losses'  => (int)$r['losses'],
        'votes'   => $votes,
        'winRate' => $votes ? (int)round(100 * $r['wins'] / $votes) : null,
        'status'  => $r['status'] ?? 'active',
        'tier'    => tier((float)$r['rating'], $votes),
    ];
}
