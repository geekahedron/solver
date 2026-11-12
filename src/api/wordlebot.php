<?php
/* Solver-local WordleBot list cache.
 * GET api/wordlebot.php
 * GET api/wordlebot.php?refresh=1
 *
 * A copy younger than 24 hours is served as-is. refresh=1 does not override
 * that. An older or missing copy is fetched from the URLs in
 * packs/wordle-nyt.json. A failed fetch keeps the last good file.
 * The cache lives in data/wordlebot/, which data/.htaccess hides from the web.
 */
ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

require __DIR__ . '/wordlebot-lib.php';

$manifestPath = __DIR__ . '/../packs/wordle-nyt.json';
$raw = @file_get_contents($manifestPath);
$manifest = $raw ? json_decode($raw, true) : null;
if (!is_array($manifest)) {
    echo json_encode(array(
        'ok' => false,
        'origin' => 'none',
        'error' => 'Wordle pack manifest is missing',
        'lists' => null
    ));
    exit;
}

$asked = isset($_GET['refresh']) && $_GET['refresh'] !== '' && $_GET['refresh'] !== '0';
$cachePath = __DIR__ . '/../data/wordlebot/cache.json';
$payload = wordlebot_serve($manifest, $cachePath, time(), $asked, 'wordlebot_fetch_lists');
echo json_encode($payload);
