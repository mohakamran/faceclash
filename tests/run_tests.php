<?php
/**
 * FaceClash 2.0 end-to-end API tests.
 *
 *   php tests/run_tests.php
 *
 * Copies the app into a temporary folder, gives it a fresh database and a random
 * admin password, starts PHP's built-in server on a free port, and runs every
 * check against that copy. Your real data/ and uploads/ are never touched.
 */
declare(strict_types=1);

$root = dirname(__DIR__);
$tmp  = sys_get_temp_dir() . '/faceclash-test-' . bin2hex(random_bytes(4));

// ---------- set up an isolated copy ----------
function copy_tree(string $from, string $to): void
{
    @mkdir($to, 0775, true);
    foreach (scandir($from) as $f) {
        if ($f === '.' || $f === '..') continue;
        is_dir("$from/$f") ? copy_tree("$from/$f", "$to/$f") : copy("$from/$f", "$to/$f");
    }
}
function rm_tree(string $dir): void
{
    if (!is_dir($dir)) return;
    foreach (scandir($dir) as $f) {
        if ($f === '.' || $f === '..') continue;
        is_dir("$dir/$f") ? rm_tree("$dir/$f") : unlink("$dir/$f");
    }
    rmdir($dir);
}
mkdir($tmp, 0775, true);
foreach (glob("$root/*.{php,html,js,css}", GLOB_BRACE) as $f) copy($f, "$tmp/" . basename($f));
copy_tree("$root/faces", "$tmp/faces");
@mkdir("$tmp/data"); @mkdir("$tmp/uploads");
$password = bin2hex(random_bytes(8));
file_put_contents("$tmp/data/admin.json", json_encode(['hash' => password_hash($password, PASSWORD_DEFAULT)]));

$sock = stream_socket_server('tcp://127.0.0.1:0');
$port = (int)substr(strrchr(stream_socket_get_name($sock, false), ':'), 1);
fclose($sock);
$server = proc_open([PHP_BINARY, '-S', "127.0.0.1:$port", '-t', $tmp, "$tmp/router.php"], [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
register_shutdown_function(function () use ($server, $tmp) { proc_terminate($server); rm_tree($tmp); });
for ($i = 0; $i < 50 && !@fsockopen('127.0.0.1', $port); $i++) usleep(100_000);

// ---------- tiny HTTP client with a cookie jar per "browser" ----------
final class Client
{
    private array $cookies = [];
    public function __construct(private string $base) {}
    public function call(string $action, ?array $body = null, string $contentType = 'application/json'): array
    {
        $headers = ["Content-Type: $contentType"];
        if ($this->cookies) $headers[] = 'Cookie: ' . http_build_query($this->cookies, '', '; ');
        $ctx = stream_context_create(['http' => [
            'method' => $body === null ? 'GET' : 'POST', 'header' => implode("\r\n", $headers),
            'content' => $body === null ? '' : json_encode($body), 'ignore_errors' => true,
        ]]);
        $raw = file_get_contents($this->base . $action, false, $ctx);
        $hdrs = http_get_last_response_headers() ?? [];
        $code = (int)explode(' ', $hdrs[0])[1];
        foreach ($hdrs as $h) {
            if (preg_match('/^Set-Cookie:\s*([^=]+)=([^;]*)/i', $h, $m)) $this->cookies[$m[1]] = $m[2];
        }
        $json = json_decode((string)$raw, true);
        return [$code, $json ?? $raw];
    }
}
function get_code(string $url): int
{
    @file_get_contents($url, false, stream_context_create(['http' => ['ignore_errors' => true]]));
    return (int)explode(' ', (http_get_last_response_headers() ?? ['x 0'])[0])[1];
}

$pass = 0; $fail = 0;
function check(string $name, bool $ok, string $detail = ''): void
{
    global $pass, $fail;
    $ok ? $pass++ : $fail++;
    echo ($ok ? "  \033[32m✔\033[0m " : "  \033[31m✘\033[0m ") . $name . ($ok || $detail === '' ? '' : "  ($detail)") . "\n";
}
function section(string $t): void { echo "\n\033[1m$t\033[0m\n"; }

$base  = "http://127.0.0.1:$port/";
$api   = $base . 'api.php?action=';
$anon  = new Client($api);
$admin = new Client($api);
$jpeg  = 'data:image/jpeg;base64,' . base64_encode(file_get_contents("$root/faces/face01.jpg"));

echo "FaceClash 2.0 tests (isolated copy on port $port)\n";

section('Pages & private files');
check('home page loads', get_code($base) === 200);
check('admin page loads', get_code($base . 'admin.html') === 200);
foreach (['data/hotornot.sqlite', 'data/admin.json', 'db.php', 'router.php', 'scripts/set_admin_password.php'] as $p) {
    check("/$p is blocked", get_code($base . $p) === 404);
}

section('Starting state');
[$c, $b] = $anon->call('board');
check('board returns 30 faces', $c === 200 && count($b['people']) === 30, "got " . count($b['people'] ?? []));
check('every face starts at 0', array_unique(array_column($b['people'], 'rating')) === [0]);
check('new faces have the New tier', $b['people'][0]['tier']['key'] === 'new');
[$c, $cfg] = $anon->call('config');
check('public config has defaults', $cfg === ['roundsPerGame' => 10, 'uploadsOpen' => true, 'requireApproval' => false]);

section('Voting & Elo');
[$c, $p] = $anon->call('pair');
check('pair returns two different faces', $c === 200 && $p['pair'][0]['id'] !== $p['pair'][1]['id']);
[$c, $v] = $anon->call('vote', ['winner' => $p['pair'][0]['id']]);
check('vote accepted', $c === 200);
check('even match moves 16 points', $v['delta'] === 16 && $v['winner']['rating'] === 16 && $v['loser']['rating'] === -16);
usleep(350_000);
[$c] = $anon->call('vote', ['winner' => $p['pair'][0]['id']]);
check('same pair cannot be voted twice', $c === 409);
usleep(350_000);
[$c] = $anon->call('vote', ['winner' => 999999]);
check('vote for a face not shown is rejected', $c === 409);
usleep(350_000);
[, $p1] = $anon->call('pair');
[$c1] = $anon->call('vote', ['winner' => $p1['pair'][0]['id']]);
[, $p2] = $anon->call('pair');
[$c3] = $anon->call('vote', ['winner' => $p2['pair'][0]['id']]);
check('votes faster than 300 ms are throttled', $c1 === 200 && $c3 === 429, "first=$c1 second=$c3");
[$c] = (new Client($api))->call('vote', ['winner' => 1], 'text/plain');
check('non-JSON POST is refused', $c === 415);
usleep(350_000);
for ($i = 0; $i < 6; $i++) { [, $pp] = $anon->call('pair'); $anon->call('vote', ['winner' => $pp['pair'][0]['id']]); usleep(320_000); }
[, $b] = $anon->call('board');
check('scores still sum to zero', array_sum(array_column($b['people'], 'rating')) === 0 || abs(array_sum(array_column($b['people'], 'rating'))) <= count($b['people']));
check('board reports streaks', array_key_exists('streak', $b['people'][0]));

section('Stats & profiles');
[$c, $s] = $anon->call('stats');
check('stats has history series', $c === 200 && count($s['series']) > 0 && count($s['hourly']) === 24);
check('stats counts votes', $s['totalVotes'] === $b['totalVotes']);
$top = $b['people'][0]['id'];
[$c, $pr] = $anon->call("person&id=$top");
check('profile has history, peak, form', $c === 200 && count($pr['history']) > 1 && isset($pr['person']['peak'], $pr['person']['form'], $pr['person']['bestStreak']));
check('top face is ranked #1', $pr['person']['rank'] === 1);

section('Visitor uploads');
[$c] = $anon->call('add', ['name' => 'Sam', 'consent' => false, 'image' => $jpeg]);
check('upload without consent is refused', $c === 422);
[$c] = $anon->call('add', ['name' => 'Sam', 'consent' => true, 'image' => 'data:image/jpeg;base64,AAAA']);
check('invalid image is refused', $c === 422);
[$c, $up] = $anon->call('add', ['name' => 'Sam', 'consent' => true, 'image' => $jpeg]);
check('valid upload goes live', $c === 201 && $up['person']['status'] === 'active' && strlen($up['deleteToken']) === 32);
[$c] = $anon->call('remove', ['id' => $up['person']['id'], 'token' => 'wrong']);
check('remove with wrong token is refused', $c === 403);
[$c] = $anon->call('remove', ['id' => $up['person']['id'], 'token' => $up['deleteToken']]);
check('uploader can remove their photo', $c === 200 && !glob("$tmp/uploads/*.jpg"));

section('Admin access');
foreach (['admin_overview', 'admin_faces', 'admin_votes', 'admin_export&type=votes'] as $a) {
    check("$a needs login", $anon->call($a)[0] === 403);
}
check('reset needs login', $anon->call('reset', [])[0] === 403);
check('wrong password refused', $admin->call('admin_login', ['password' => 'nope'])[0] === 401);
check('right password accepted', $admin->call('admin_login', ['password' => $password])[0] === 200);
[$c, $o] = $admin->call('admin_overview');
check('overview loads', $c === 200 && $o['activeFaces'] === 30);

section('Admin tools');
[, $s] = $admin->call('admin_settings', ['roundsPerGame' => 7, 'requireApproval' => true]);
check('settings save and clamp', $s['settings']['roundsPerGame'] === 7 && $admin->call('admin_settings', ['roundsPerGame' => 99])[1]['settings']['roundsPerGame'] === 30);
[$c, $up] = $anon->call('add', ['name' => 'Pending Pat', 'consent' => true, 'image' => $jpeg]);
check('with approval on, uploads wait', $up['person']['status'] === 'pending');
check('pending face is not public', !in_array($up['person']['id'], array_column($anon->call('board')[1]['people'], 'id'), true));
[$c, $f] = $admin->call('admin_update_face', ['id' => $up['person']['id'], 'status' => 'active', 'name' => 'Pat']);
check('admin can approve and rename', $f['face']['status'] === 'active' && $f['face']['name'] === 'Pat');
[$c, $add] = $admin->call('admin_add', ['name' => 'Admin Face', 'image' => $jpeg, 'rights' => true]);
check('admin upload goes live immediately', $c === 201 && $add['face']['status'] === 'active');
check('admin upload needs the rights box', $admin->call('admin_add', ['name' => 'X', 'image' => $jpeg])[0] === 422);
[$c, $bk] = $admin->call('admin_bulk', ['op' => 'hide', 'ids' => [1, 2, 3]]);
check('bulk hide', $bk['changed'] === 3 && count($anon->call('board')[1]['people']) === 29);
[$c, $bk] = $admin->call('admin_bulk', ['op' => 'remove', 'ids' => [$up['person']['id'], $add['face']['id']]]);
check('bulk delete removes faces and files', $bk['changed'] === 2 && !glob("$tmp/uploads/*.jpg"));
check('bulk with bad action refused', $admin->call('admin_bulk', ['op' => 'nuke', 'ids' => [1]])[0] === 422);
[$c, $csv] = $admin->call('admin_export&type=leaderboard');
check('CSV export works', $c === 200 && str_starts_with((string)$csv, 'rank,name,score'));
[$c, $vl] = $admin->call('admin_votes');
check('vote log lists votes', $c === 200 && count($vl['votes']) > 0);
check('password change checks current password', $admin->call('admin_password', ['current' => 'x', 'new' => 'abcdefgh'])[0] === 401);
[$c] = $admin->call('reset', []);
[, $b] = $anon->call('board');
check('admin reset sets everyone to 0', $c === 200 && $b['totalVotes'] === 0 && array_unique(array_column($b['people'], 'rating')) === [0]);
check('logout ends admin session', $admin->call('admin_logout', [])[0] === 200 && $admin->call('admin_overview')[0] === 403);

echo "\n" . ($fail ? "\033[31m$fail failed\033[0m, " : '') . "\033[32m$pass passed\033[0m\n";
exit($fail ? 1 : 0);
