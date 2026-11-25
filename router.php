<?php
// Router for PHP's built-in server: `php -S localhost:8765 router.php`
// Blocks the database, scripts, tests and PHP internals from being downloaded or run.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?? '/';
if (preg_match('#^/(data|scripts|tests|\.claude|\.git)(/|$)#', $path) || in_array($path, ['/db.php', '/router.php'], true)) {
    http_response_code(404);
    exit('Not found');
}
if ($path === '/') {
    readfile(__DIR__ . '/index.html');
    return true;
}
return false; // let the built-in server serve the file (or run api.php)
