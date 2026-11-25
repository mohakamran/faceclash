<?php
// Set (or change) the admin password. Only a bcrypt hash is stored, in data/admin.json.
// Usage:  php scripts/set_admin_password.php            (prompts, input hidden)
//         php scripts/set_admin_password.php --random   (generates one, saves it to data/admin-password.txt)
declare(strict_types=1);
if (PHP_SAPI !== 'cli') exit("Run from the command line.\n");

$dir = dirname(__DIR__) . '/data';
if (!is_dir($dir)) mkdir($dir, 0775, true);

if (in_array('--random', $argv, true)) {
    $pw = rtrim(strtr(base64_encode(random_bytes(12)), '+/', 'xy'), '=');
    file_put_contents("$dir/admin-password.txt", $pw . "\n");
    chmod("$dir/admin-password.txt", 0600);
    echo "Random admin password saved to data/admin-password.txt (blocked from the web).\n";
} else {
    echo 'New admin password (min 8 chars): ';
    system('stty -echo');
    $pw = trim((string)fgets(STDIN));
    system('stty echo');
    echo "\n";
    if (strlen($pw) < 8) exit("Too short, nothing changed.\n");
    @unlink("$dir/admin-password.txt");
}

file_put_contents("$dir/admin.json", json_encode(['hash' => password_hash($pw, PASSWORD_DEFAULT)]));
chmod("$dir/admin.json", 0600);
echo "Admin password set.\n";
