<?php
/**
 * FaceClash 2.0 JSON API.
 *   GET  api.php?action=pair    -> two random people (remembered in the session)
 *   POST api.php?action=vote    {winner:id}  -> Elo update for the current pair
 *   GET  api.php?action=board   -> live leaderboard + recent votes
 *   POST api.php?action=add     {name, consent, image:dataURL} -> opt-in upload
 *   GET  api.php?action=stats   -> chart data: top-4 score history, votes per hour, totals
 *   GET  api.php?action=person&id=N -> one face's score history and rivals
 *   POST api.php?action=remove  {id, token}  -> uploader deletes their own photo
 *   GET  api.php?action=admin_status          -> is this session an admin?
 *   POST api.php?action=admin_login {password} / admin_logout
 *   POST api.php?action=admin_delete {id}     -> admin removes any face
 *   POST api.php?action=reset                 -> admin only: scores back to 0, history cleared
 *   GET  api.php?action=config                -> public settings (rounds per game, uploads open)
 *   Admin dashboard (all need an admin session):
 *     GET  admin_overview | admin_faces | admin_votes[&before=id] | admin_export&type=leaderboard|votes
 *     POST admin_update_face {id, name?, status?} | admin_reset_face {id}
 *          admin_bulk {ids:[...], op: remove|hide|show|approve|reset}
 *          admin_add {name, image, rights:true} -> face goes live immediately
 *          admin_settings {...} | admin_password {current, new}
 */
declare(strict_types=1);
require __DIR__ . '/db.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function out(array $data, int $code = 200): never
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_SLASHES);
    exit;
}
function body(): array
{
    $b = json_decode(file_get_contents('php://input') ?: '', true);
    return is_array($b) ? $b : [];
}
function require_post(): void
{
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') out(['error' => 'POST required'], 405);
    // JSON-only + SameSite=Strict cookie: other sites can't forge votes or admin actions.
    if (!str_starts_with($_SERVER['CONTENT_TYPE'] ?? '', 'application/json')) out(['error' => 'JSON body required'], 415);
}
/** Validate a JPEG data URL and store it in uploads/. Returns the file name. */
function save_upload($dataUrl): string
{
    if (!preg_match('#^data:image/jpeg;base64,([A-Za-z0-9+/=]+)$#', (string)$dataUrl, $m)) out(['error' => 'Image must be a JPEG.'], 422);
    $bytes = base64_decode($m[1], true);
    if ($bytes === false || strlen($bytes) > 1_500_000) out(['error' => 'Image is too large.'], 422);
    $info = @getimagesizefromstring($bytes);
    if (!$info || $info['mime'] !== 'image/jpeg') out(['error' => 'That file is not a valid image.'], 422);
    $dir = __DIR__ . '/uploads';
    if (!is_dir($dir)) mkdir($dir, 0775, true);
    $file = 'u_' . bin2hex(random_bytes(8)) . '.jpg';
    file_put_contents("$dir/$file", $bytes);
    return $file;
}
function clean_name($n): string
{
    $name = trim(preg_replace('/\s+/u', ' ', (string)$n));
    if ($name === '' || mb_strlen($name) > 24) out(['error' => 'Name must be 1–24 characters.'], 422);
    return $name;
}

function start_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) return;
    session_set_cookie_params(['httponly' => true, 'samesite' => 'Strict', 'secure' => !empty($_SERVER['HTTPS'])]);
    session_start();
}
function require_admin(): void
{
    start_session();
    if (empty($_SESSION['admin'])) out(['error' => 'Admin login required'], 403);
}

const VOTE_MIN_GAP_MS  = 300;  // per browser session
const VOTES_PER_HOUR   = 600;  // per network address
const PAIR_RANDOM_PICK = 0.2;  // share of pairs that are fully random

$action = $_GET['action'] ?? '';

try {
    $pdo = db();

    switch ($action) {

    case 'pair':
        start_session();
        $rows = $pdo->query("SELECT * FROM people WHERE status = 'active'")->fetchAll();
        if (count($rows) < 2) out(['error' => 'Need at least two people'], 409);

        // Smart matchmaking: favour faces with few votes, and pit them against someone
        // with a similar score. Close matchups tell us the most, so rankings settle faster.
        $pickFirst = function () use ($rows): int {
            $weights = array_map(fn($r) => 1 / (1 + $r['wins'] + $r['losses']), $rows);
            $x = mt_rand() / mt_getrandmax() * array_sum($weights);
            foreach ($weights as $i => $w) { if (($x -= $w) <= 0) return $i; }
            return array_key_last($rows);
        };
        $pickOpponent = function (int $i) use ($rows): int {
            $others = array_keys($rows);
            unset($others[$i]);
            usort($others, fn($p, $q) => abs($rows[$p]['rating'] - $rows[$i]['rating']) <=> abs($rows[$q]['rating'] - $rows[$i]['rating']));
            $near = array_slice($others, 0, min(6, count($others)));
            return $near[array_rand($near)];
        };

        $seen = $_SESSION['seen'] ?? [];
        if (count($seen) > 400) $seen = [];
        for ($t = 0; $t < 60; $t++) {
            if (mt_rand() / mt_getrandmax() < PAIR_RANDOM_PICK) {
                $k = array_rand($rows, 2);
            } else {
                $i = $pickFirst();
                $k = [$i, $pickOpponent($i)];
            }
            if (mt_rand(0, 1)) $k = array_reverse($k);
            [$a, $b] = [$rows[$k[0]], $rows[$k[1]]];
            $key = min($a['id'], $b['id']) . '-' . max($a['id'], $b['id']);
            if (!isset($seen[$key])) break;
        }
        $seen[$key] = 1;
        $_SESSION['seen'] = $seen;
        $_SESSION['pair'] = [(int)$a['id'], (int)$b['id']];
        out(['pair' => [person($a), person($b)]]);

    case 'vote':
        require_post();
        start_session();
        $nowMs = (int)(microtime(true) * 1000);
        if ($nowMs - ($_SESSION['last_vote_ms'] ?? 0) < VOTE_MIN_GAP_MS) out(['error' => 'Slow down a little!'], 429);
        $winner = (int)(body()['winner'] ?? 0);
        $pair   = $_SESSION['pair'] ?? null;
        // Only the pair this session was shown can be voted on, and only once.
        if (!$pair || !in_array($winner, $pair, true)) out(['error' => 'That pair expired — loading a new one'], 409);
        unset($_SESSION['pair']);
        $_SESSION['last_vote_ms'] = $nowMs;
        session_write_close();

        $ip = ip_hash();
        $recentFromIp = $pdo->prepare('SELECT COUNT(*) FROM votes WHERE ip_hash = ? AND at > ?');
        $recentFromIp->execute([$ip, time() - 3600]);
        if ((int)$recentFromIp->fetchColumn() >= VOTES_PER_HOUR) out(['error' => 'Vote limit reached for now. Try again later.'], 429);
        $loser = $pair[0] === $winner ? $pair[1] : $pair[0];

        $pdo->exec('BEGIN IMMEDIATE');
        $get = $pdo->prepare('SELECT * FROM people WHERE id = ?');
        $get->execute([$winner]); $w = $get->fetch();
        $get->execute([$loser]);  $l = $get->fetch();
        if (!$w || !$l) { $pdo->exec('ROLLBACK'); out(['error' => 'Person not found'], 404); }

        // Elo: chance the winner was expected to win, then move points from loser to winner.
        $expected = 1 / (1 + 10 ** (((float)$l['rating'] - (float)$w['rating']) / 400));
        $delta    = K_FACTOR * (1 - $expected);

        $pdo->prepare('UPDATE people SET rating = rating + ?, wins = wins + 1 WHERE id = ?')->execute([$delta, $winner]);
        $pdo->prepare('UPDATE people SET rating = rating - ?, losses = losses + 1 WHERE id = ?')->execute([$delta, $loser]);
        $get->execute([$winner]); $w = $get->fetch();
        $get->execute([$loser]);  $l = $get->fetch();
        $pdo->prepare('INSERT INTO votes (winner, loser, delta, at, winner_after, loser_after, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
            ->execute([$winner, $loser, $delta, time(), $w['rating'], $l['rating'], $ip]);
        $pdo->exec('COMMIT');

        out([
            'winner'   => person($w),
            'loser'    => person($l),
            'delta'    => (int)round($delta),
            'expected' => (int)round($expected * 100),
        ]);

    case 'board':
        $people = array_map('person', $pdo->query("SELECT * FROM people WHERE status = 'active' ORDER BY rating DESC, wins DESC, id ASC")->fetchAll());

        // Current win streak per face, from the most recent votes.
        $streak = []; $closed = [];
        foreach ($pdo->query('SELECT winner, loser FROM votes ORDER BY id DESC LIMIT 2000') as $v) {
            $w = (int)$v['winner']; $l = (int)$v['loser'];
            if (!isset($closed[$w])) $streak[$w] = ($streak[$w] ?? 0) + 1;
            $closed[$l] = true;
        }
        foreach ($people as &$p) $p['streak'] = $streak[$p['id']] ?? 0;
        unset($p);
        $recent = $pdo->query('SELECT v.delta, v.at, w.name AS winner, l.name AS loser
                               FROM votes v JOIN people w ON w.id = v.winner JOIN people l ON l.id = v.loser
                               ORDER BY v.id DESC LIMIT 6')->fetchAll();
        foreach ($recent as &$r) { $r['delta'] = (int)round((float)$r['delta']); $r['at'] = (int)$r['at']; }
        out([
            'people'     => $people,
            'totalVotes' => (int)$pdo->query('SELECT COUNT(*) FROM votes')->fetchColumn(),
            'recent'     => $recent,
            'now'        => time(),
        ]);

    case 'stats':
        $votes = $pdo->query('SELECT id, winner, loser, delta, at, winner_after, loser_after FROM votes ORDER BY id')->fetchAll();
        $top   = array_map('person', $pdo->query("SELECT * FROM people WHERE status = 'active' AND wins + losses > 0 ORDER BY rating DESC, wins DESC, id LIMIT 4")->fetchAll());

        // Score of each top face after every vote it took part in. x = vote number (1..N).
        $series = [];
        foreach ($top as $p) $series[$p['id']] = ['id' => $p['id'], 'name' => $p['name'], 'img' => $p['img'], 'points' => [[0, START_RATING]]];
        foreach ($votes as $n => $v) {
            foreach (['winner', 'loser'] as $side) {
                $id = (int)$v[$side];
                if (isset($series[$id]) && $v[$side . '_after'] !== null) {
                    $series[$id]['points'][] = [$n + 1, (int)round((float)$v[$side . '_after'])];
                }
            }
        }

        // Votes per hour for the last 24 hours (oldest first).
        $now = time();
        $hourStart = $now - ($now % 3600);
        $hours = [];
        for ($h = 23; $h >= 0; $h--) $hours[$hourStart - $h * 3600] = 0;
        foreach ($votes as $v) {
            $b = (int)$v['at'] - ((int)$v['at'] % 3600);
            if (isset($hours[$b])) $hours[$b]++;
        }

        $upset = $pdo->query('SELECT v.delta, w.name AS winner, l.name AS loser FROM votes v
                              JOIN people w ON w.id = v.winner JOIN people l ON l.id = v.loser
                              ORDER BY v.delta DESC LIMIT 1')->fetch() ?: null;
        if ($upset) $upset['delta'] = (int)round((float)$upset['delta']);

        out([
            'totalVotes'   => count($votes),
            'faces'        => (int)$pdo->query("SELECT COUNT(*) FROM people WHERE status = 'active'")->fetchColumn(),
            'votesToday'   => array_sum($hours),
            'biggestUpset' => $upset,
            'series'       => array_values($series),
            'hourly'       => array_map(fn($t, $c) => ['t' => $t, 'count' => $c], array_keys($hours), $hours),
        ]);

    case 'person':
        $id  = (int)($_GET['id'] ?? 0);
        $get = $pdo->prepare('SELECT * FROM people WHERE id = ?');
        $get->execute([$id]);
        $row = $get->fetch();
        if (!$row) out(['error' => 'Not found'], 404);

        // Compare inside SQLite so no precision is lost turning the score into text.
        $rk = $pdo->prepare("SELECT COUNT(*) FROM people WHERE status = 'active' AND rating > (SELECT rating FROM people WHERE id = ?)");
        $rk->execute([$id]);
        $rank = 1 + (int)$rk->fetchColumn();
        $hist = $pdo->prepare('SELECT id, at, winner, loser, winner_after, loser_after FROM votes WHERE winner = ? OR loser = ? ORDER BY id');
        $hist->execute([$id, $id]);
        $points = [[0, START_RATING, null]];
        $n = 0; $run = 0; $best = 0; $peak = START_RATING;
        foreach ($hist as $v) {
            $won = (int)$v['winner'] === $id;
            $after = $won ? $v['winner_after'] : $v['loser_after'];
            if ($after === null) continue;
            $points[] = [++$n, (int)round((float)$after), $won ? 'W' : 'L'];
            $run  = $won ? $run + 1 : 0;
            $best = max($best, $run);
            $peak = max($peak, (int)round((float)$after));
        }
        $form = array_map(fn($p) => $p[2], array_slice($points, -10));
        $form = array_values(array_filter($form));

        $rivals = $pdo->prepare('SELECT p.name, SUM(v.winner = :id) AS beat, SUM(v.loser = :id) AS lostTo
                                 FROM votes v JOIN people p ON p.id = CASE WHEN v.winner = :id THEN v.loser ELSE v.winner END
                                 WHERE v.winner = :id OR v.loser = :id
                                 GROUP BY p.id ORDER BY (beat + lostTo) DESC, p.name LIMIT 5');
        $rivals->execute([':id' => $id]);

        out([
            'person'  => person($row) + ['rank' => $rank, 'streak' => $run, 'bestStreak' => $best, 'peak' => $peak, 'form' => $form],
            'history' => $points,
            'rivals'  => array_map(fn($r) => ['name' => $r['name'], 'beat' => (int)$r['beat'], 'lostTo' => (int)$r['lostTo']], $rivals->fetchAll()),
        ]);

    case 'add':
        require_post();
        $cfg = settings($pdo);
        if (!$cfg['uploadsOpen']) out(['error' => 'Uploads are closed right now.'], 403);
        $b    = body();
        $name = trim(preg_replace('/\s+/u', ' ', (string)($b['name'] ?? '')));
        if (($b['consent'] ?? false) !== true) out(['error' => 'Please confirm the photo is you and you consent.'], 422);
        if ($name === '' || mb_strlen($name) > 24) out(['error' => 'Name must be 1–24 characters.'], 422);

        $file = save_upload($b['image'] ?? '');

        // A private token lets the uploader remove their photo later, no account needed.
        $token = bin2hex(random_bytes(16));
        $status = $cfg['requireApproval'] ? 'pending' : 'active';
        $pdo->prepare('INSERT INTO people (name, img, rating, uploaded, created_at, delete_hash, status) VALUES (?, ?, ' . START_RATING . ', 1, ?, ?, ?)')
            ->execute([$name, "uploads/$file", time(), hash('sha256', $token), $status]);
        $get = $pdo->prepare('SELECT * FROM people WHERE id = ?');
        $get->execute([(int)$pdo->lastInsertId()]);
        out(['person' => person($get->fetch()), 'deleteToken' => $token], 201);

    case 'remove':
        require_post();
        $b  = body();
        $id = (int)($b['id'] ?? 0);
        $get = $pdo->prepare('SELECT delete_hash FROM people WHERE id = ? AND uploaded = 1');
        $get->execute([$id]);
        $hash = $get->fetchColumn();
        if (!$hash || !hash_equals($hash, hash('sha256', (string)($b['token'] ?? '')))) out(['error' => 'Not allowed'], 403);
        delete_person($pdo, $id);
        out(['ok' => true]);

    case 'admin_status':
        start_session();
        out(['admin' => !empty($_SESSION['admin']), 'configured' => admin_hash() !== null]);

    case 'admin_login':
        require_post();
        start_session();
        $hash = admin_hash();
        if (!$hash) out(['error' => 'No admin password set. Run: php scripts/set_admin_password.php'], 409);
        if (!password_verify((string)(body()['password'] ?? ''), $hash)) {
            sleep(1); // slows down password guessing
            out(['error' => 'Wrong password'], 401);
        }
        session_regenerate_id(true);
        $_SESSION['admin'] = true;
        out(['admin' => true]);

    case 'admin_logout':
        require_post();
        start_session();
        unset($_SESSION['admin']);
        out(['admin' => false]);

    case 'admin_delete':
        require_post();
        require_admin();
        if (!delete_person($pdo, (int)(body()['id'] ?? 0))) out(['error' => 'Not found'], 404);
        out(['ok' => true]);

    case 'config':
        $cfg = settings($pdo);
        out(['roundsPerGame' => $cfg['roundsPerGame'], 'uploadsOpen' => $cfg['uploadsOpen'], 'requireApproval' => $cfg['requireApproval']]);

    // ---------------- Admin dashboard ----------------
    case 'admin_overview':
        require_admin();
        $now = time();
        $q = fn(string $sql, array $p = []) => (function () use ($pdo, $sql, $p) { $st = $pdo->prepare($sql); $st->execute($p); return (int)$st->fetchColumn(); })();
        out([
            'totalVotes'    => $q('SELECT COUNT(*) FROM votes'),
            'votesToday'    => $q('SELECT COUNT(*) FROM votes WHERE at > ?', [$now - 86400]),
            'votesHour'     => $q('SELECT COUNT(*) FROM votes WHERE at > ?', [$now - 3600]),
            'votersHour'    => $q('SELECT COUNT(DISTINCT ip_hash) FROM votes WHERE at > ?', [$now - 3600]),
            'votersToday'   => $q('SELECT COUNT(DISTINCT ip_hash) FROM votes WHERE at > ?', [$now - 86400]),
            'activeFaces'   => $q("SELECT COUNT(*) FROM people WHERE status = 'active'"),
            'hiddenFaces'   => $q("SELECT COUNT(*) FROM people WHERE status = 'hidden'"),
            'pending'       => $q("SELECT COUNT(*) FROM people WHERE status = 'pending'"),
            'uploads'       => $q('SELECT COUNT(*) FROM people WHERE uploaded = 1'),
            'settings'      => settings($pdo),
        ]);

    case 'admin_faces':
        require_admin();
        $rows = $pdo->query("SELECT * FROM people
                             ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, rating DESC, id")->fetchAll();
        $src = [0 => 'built-in', 1 => 'visitor', 2 => 'admin'];
        out(['faces' => array_map(fn($r) => person($r) + [
            'uploaded'  => (int)$r['uploaded'] > 0,          // has a photo file in uploads/
            'source'    => $src[(int)$r['uploaded']] ?? 'built-in',
            'createdAt' => (int)$r['created_at'],
        ], $rows)]);

    case 'admin_update_face':
        require_post();
        require_admin();
        $b  = body();
        $id = (int)($b['id'] ?? 0);
        if (isset($b['name'])) {
            $name = trim(preg_replace('/\s+/u', ' ', (string)$b['name']));
            if ($name === '' || mb_strlen($name) > 24) out(['error' => 'Name must be 1–24 characters.'], 422);
            $pdo->prepare('UPDATE people SET name = ? WHERE id = ?')->execute([$name, $id]);
        }
        if (isset($b['status'])) {
            if (!in_array($b['status'], ['active', 'hidden'], true)) out(['error' => 'Bad status'], 422);
            $pdo->prepare('UPDATE people SET status = ? WHERE id = ?')->execute([$b['status'], $id]);
        }
        $get = $pdo->prepare('SELECT * FROM people WHERE id = ?');
        $get->execute([$id]);
        $row = $get->fetch() ?: out(['error' => 'Not found'], 404);
        out(['face' => person($row)]);

    case 'admin_reset_face':
        require_post();
        require_admin();
        $st = $pdo->prepare('UPDATE people SET rating = ' . START_RATING . ', wins = 0, losses = 0 WHERE id = ?');
        $st->execute([(int)(body()['id'] ?? 0)]);
        if (!$st->rowCount()) out(['error' => 'Not found'], 404);
        out(['ok' => true]);

    case 'admin_add':
        require_post();
        require_admin();
        $b = body();
        if (($b['rights'] ?? false) !== true) out(['error' => 'Please confirm you have permission to use these photos.'], 422);
        $name = clean_name($b['name'] ?? '');
        $file = save_upload($b['image'] ?? '');
        // uploaded = 2 marks "added by admin" (1 = uploaded by a visitor, 0 = built-in)
        $pdo->prepare("INSERT INTO people (name, img, rating, uploaded, created_at, status) VALUES (?, ?, " . START_RATING . ", 2, ?, 'active')")
            ->execute([$name, "uploads/$file", time()]);
        $get = $pdo->prepare('SELECT * FROM people WHERE id = ?');
        $get->execute([(int)$pdo->lastInsertId()]);
        out(['face' => person($get->fetch())], 201);

    case 'admin_bulk':
        require_post();
        require_admin();
        $b   = body();
        $op  = (string)($b['op'] ?? '');
        $ids = array_values(array_unique(array_filter(array_map('intval', (array)($b['ids'] ?? [])), fn($i) => $i > 0)));
        if (!$ids) out(['error' => 'Select at least one face'], 422);
        if (count($ids) > 1000) out(['error' => 'Too many at once (max 1000)'], 422);

        $pdo->exec('BEGIN IMMEDIATE');
        $done = 0;
        $in   = implode(',', array_fill(0, count($ids), '?'));
        switch ($op) {
            case 'remove':
                foreach ($ids as $id) $done += delete_person($pdo, $id) ? 1 : 0;
                break;
            case 'hide':
                $st = $pdo->prepare("UPDATE people SET status = 'hidden' WHERE status = 'active' AND id IN ($in)");
                $st->execute($ids); $done = $st->rowCount();
                break;
            case 'show':
            case 'approve':
                $st = $pdo->prepare("UPDATE people SET status = 'active' WHERE status IN ('hidden','pending') AND id IN ($in)");
                $st->execute($ids); $done = $st->rowCount();
                break;
            case 'reset':
                $st = $pdo->prepare('UPDATE people SET rating = ' . START_RATING . ", wins = 0, losses = 0 WHERE id IN ($in)");
                $st->execute($ids); $done = $st->rowCount();
                break;
            default:
                $pdo->exec('ROLLBACK');
                out(['error' => 'Unknown bulk action'], 422);
        }
        $pdo->exec('COMMIT');
        out(['ok' => true, 'changed' => $done]);

    case 'admin_votes':
        require_admin();
        $before = (int)($_GET['before'] ?? PHP_INT_MAX);
        $st = $pdo->prepare('SELECT v.id, v.at, v.delta, v.ip_hash, v.winner_after, v.loser_after,
                                    COALESCE(w.name, \'(removed)\') AS winner, COALESCE(l.name, \'(removed)\') AS loser
                             FROM votes v LEFT JOIN people w ON w.id = v.winner LEFT JOIN people l ON l.id = v.loser
                             WHERE v.id < ? ORDER BY v.id DESC LIMIT 50');
        $st->execute([$before]);
        $rows = array_map(fn($r) => [
            'id' => (int)$r['id'], 'at' => (int)$r['at'], 'delta' => (int)round((float)$r['delta']),
            'winner' => $r['winner'], 'loser' => $r['loser'],
            'winnerAfter' => $r['winner_after'] === null ? null : (int)round((float)$r['winner_after']),
            'loserAfter'  => $r['loser_after'] === null ? null : (int)round((float)$r['loser_after']),
            'voter' => $r['ip_hash'] ? substr($r['ip_hash'], 0, 6) : '—',
        ], $st->fetchAll());
        out(['votes' => $rows, 'more' => count($rows) === 50]);

    case 'admin_settings':
        require_post();
        require_admin();
        out(['settings' => save_settings($pdo, body())]);

    case 'admin_password':
        require_post();
        require_admin();
        $b = body();
        if (!password_verify((string)($b['current'] ?? ''), (string)admin_hash())) { sleep(1); out(['error' => 'Current password is wrong'], 401); }
        $new = (string)($b['new'] ?? '');
        if (strlen($new) < 8) out(['error' => 'New password must be at least 8 characters.'], 422);
        file_put_contents(__DIR__ . '/data/admin.json', json_encode(['hash' => password_hash($new, PASSWORD_DEFAULT)]));
        @unlink(__DIR__ . '/data/admin-password.txt'); // the generated one is no longer valid
        out(['ok' => true]);

    case 'admin_export':
        require_admin();
        $type = $_GET['type'] ?? 'leaderboard';
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="faceclash-' . ($type === 'votes' ? 'votes' : 'leaderboard') . '-' . date('Y-m-d') . '.csv"');
        $f = fopen('php://output', 'w');
        // Neutralise spreadsheet formulas in user-supplied names.
        $cell = fn($v) => is_string($v) && preg_match('/^[=+\-@\t\r]/', $v) ? "'" . $v : $v;
        if ($type === 'votes') {
            fputcsv($f, ['vote_id', 'time_utc', 'winner', 'loser', 'points', 'winner_score_after', 'loser_score_after'], ',', '"', '');
            $rows = $pdo->query('SELECT v.id, v.at, v.delta, v.winner_after, v.loser_after, COALESCE(w.name, \'(removed)\') AS winner, COALESCE(l.name, \'(removed)\') AS loser
                                 FROM votes v LEFT JOIN people w ON w.id = v.winner LEFT JOIN people l ON l.id = v.loser ORDER BY v.id');
            foreach ($rows as $r) fputcsv($f, [$r['id'], gmdate('Y-m-d H:i:s', (int)$r['at']), $cell($r['winner']), $cell($r['loser']), round((float)$r['delta'], 1), round((float)$r['winner_after'], 1), round((float)$r['loser_after'], 1)], ',', '"', '');
        } else {
            fputcsv($f, ['rank', 'name', 'score', 'wins', 'losses', 'win_rate_pct', 'status', 'uploaded'], ',', '"', '');
            $rank = 0;
            foreach ($pdo->query('SELECT * FROM people ORDER BY rating DESC, wins DESC, id') as $r) {
                $p = person($r);
                fputcsv($f, [++$rank, $cell($p['name']), $p['rating'], $p['wins'], $p['losses'], $p['winRate'] ?? '', $p['status'], $r['uploaded'] ? 'yes' : 'no'], ',', '"', '');
            }
        }
        exit;

    case 'reset':
        require_post();
        require_admin();
        $pdo->exec('BEGIN IMMEDIATE');
        $pdo->exec('UPDATE people SET rating = ' . START_RATING . ', wins = 0, losses = 0');
        $pdo->exec('DELETE FROM votes');
        $pdo->exec('COMMIT');
        unset($_SESSION['seen'], $_SESSION['pair']);
        out(['ok' => true]);

    default:
        out(['error' => 'Unknown action'], 404);
    }
} catch (Throwable $e) {
    if (isset($pdo) && $pdo->inTransaction()) $pdo->rollBack();
    error_log((string)$e);
    out(['error' => 'Server error'], 500);
}
