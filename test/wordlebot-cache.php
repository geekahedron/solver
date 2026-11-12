<?php
/* Parser and 24-hour cache decision. No network. Run: php test/wordlebot-cache.php */
require dirname(__DIR__) . '/src/api/wordlebot-lib.php';

$passed = 0;
function check($name, $fn) {
    global $passed;
    $fn();
    $passed++;
    echo "ok $name\n";
}
function expect($cond, $msg) {
    if (!$cond) throw new Exception($msg);
}

function fixture($name, $words) {
    $parts = array();
    foreach ($words as $word) $parts[] = '"' . $word . '"';
    return 'const ' . $name . ' = [' . implode(',', $parts) . "];\n";
}

check('extracts quoted 5-letter words and folds case', function () {
    $parsed = wordlebot_parse_const_array(fixture('official_answers_with_ed', array('ABACK', 'ABASE', 'crane', 'SLATE')), 5, 4, 0);
    expect($parsed['ok'] === true, $parsed['error']);
    expect($parsed['words'] === array('aback', 'abase', 'crane', 'slate'), json_encode($parsed['words']));
});

check('does not execute the source', function () {
    $src = fixture('official_answers', array('ABBEY', 'ABORT')) . "throw new Exception('executed');\n";
    $parsed = wordlebot_parse_const_array($src, 5, 2, 0);
    expect($parsed['ok'] === true, $parsed['error']);
    expect($parsed['words'] === array('abbey', 'abort'), json_encode($parsed['words']));
});

check('rejects HTML, short lists, and non-words', function () {
    $html = wordlebot_parse_const_array('<!DOCTYPE html><html><body>const x = ["CRANE"];</body></html>', 5, 1, 0);
    expect($html['ok'] === false && strpos($html['error'], 'HTML') !== false, $html['error']);
    $short = wordlebot_parse_const_array(fixture('official_answers', array('CRANE')), 5, 2000, 0);
    expect($short['ok'] === false && strpos($short['error'], 'at least 2000') !== false, $short['error']);
    $bad = wordlebot_parse_const_array('const official_words = ["CRANE","NO","SLATE"];', 5, 1, 0);
    expect($bad['ok'] === false && strpos($bad['error'], 'not 5 letters') !== false, $bad['error']);
});

function sample_cache($checked, $attempt, $error) {
    return array(
        'lastChecked' => $checked,
        'lastUpdated' => $checked,
        'lastAttempt' => $attempt,
        'error' => $error,
        'lists' => array('with-ed' => array('count' => 1, 'words' => array('crane')))
    );
}

check('a copy under 24 hours is served, including Check now', function () {
    $now = 1700000000;
    $cache = sample_cache($now - 3600, $now - 3600, null);
    $plain = wordlebot_plan($cache, $now, wordlebot_max_age(), wordlebot_failure_cooldown(), false);
    $asked = wordlebot_plan($cache, $now, wordlebot_max_age(), wordlebot_failure_cooldown(), true);
    expect($plain['action'] === 'serve' && $plain['refresh'] === 'cached', json_encode($plain));
    expect($asked['action'] === 'serve' && $asked['refresh'] === 'not-due', json_encode($asked));
});

check('a copy older than 24 hours is refreshed', function () {
    $now = 1700000000;
    $cache = sample_cache($now - wordlebot_max_age() - 1, $now - wordlebot_max_age() - 1, null);
    $plan = wordlebot_plan($cache, $now, wordlebot_max_age(), wordlebot_failure_cooldown(), true);
    expect($plan['action'] === 'refresh', json_encode($plan));
});

check('a recent failed attempt does not refetch', function () {
    $now = 1700000000;
    $checked = $now - wordlebot_max_age() - 10;
    $cache = sample_cache($checked, $now - 60, 'HTTP 503');
    $plan = wordlebot_plan($cache, $now, wordlebot_max_age(), wordlebot_failure_cooldown(), true);
    expect($plan['action'] === 'serve' && $plan['refresh'] === 'cooldown', json_encode($plan));
});

check('a failed attempt older than the cooldown refreshes', function () {
    $now = 1700000000;
    $checked = $now - wordlebot_max_age() - 10;
    $cache = sample_cache($checked, $now - wordlebot_failure_cooldown() - 1, 'HTTP 503');
    $plan = wordlebot_plan($cache, $now, wordlebot_max_age(), wordlebot_failure_cooldown(), false);
    expect($plan['action'] === 'refresh', json_encode($plan));
});

check('a missing cache refreshes', function () {
    $plan = wordlebot_plan(null, 1700000000, wordlebot_max_age(), wordlebot_failure_cooldown(), false);
    expect($plan['action'] === 'refresh', json_encode($plan));
});

check('serve writes once, then keeps the file across a failed refresh', function () {
    $dir = sys_get_temp_dir() . '/wordlebot-test-' . getmypid();
    @mkdir($dir, 0775, true);
    $path = $dir . '/cache.json';
    $manifest = array('remote' => array(
        'answers' => array(array('id' => 'with-ed', 'label' => 'A', 'file' => 'A.js', 'url' => 'https://example.invalid/a', 'minCount' => 1, 'maxCount' => 10)),
        'guesses' => array(array('id' => 'all', 'label' => 'G', 'file' => 'G.js', 'url' => 'https://example.invalid/g', 'minCount' => 1, 'maxCount' => 10))
    ));
    $calls = 0;
    $mode = 'ok';
    $fetcher = function () use (&$calls, &$mode) {
        $calls++;
        if ($mode === 'fail') return array('ok' => false, 'error' => 'offline', 'lists' => array());
        return array('ok' => true, 'error' => '', 'lists' => array(
            'with-ed' => array('id' => 'with-ed', 'label' => 'A', 'file' => 'A.js', 'url' => 'https://example.invalid/a', 'count' => 1, 'words' => array('crane')),
            'all' => array('id' => 'all', 'label' => 'G', 'file' => 'G.js', 'url' => 'https://example.invalid/g', 'count' => 1, 'words' => array('slate'))
        ));
    };
    $now = 1700000000;
    $first = wordlebot_serve($manifest, $path, $now, false, $fetcher);
    expect($first['ok'] === true && $first['origin'] === 'github' && $first['refresh'] === 'fetched', json_encode(array('origin' => $first['origin'], 'refresh' => $first['refresh'])));
    expect($calls === 1, 'calls ' . $calls);
    expect(is_file($path), 'cache file missing');
    $fresh = wordlebot_serve($manifest, $path, $now + 3600, true, $fetcher);
    expect($fresh['refresh'] === 'not-due' && $calls === 1, json_encode(array('refresh' => $fresh['refresh'], 'calls' => $calls)));
    $mode = 'fail';
    $stale = wordlebot_serve($manifest, $path, $now + wordlebot_max_age() + 5, true, $fetcher);
    expect($stale['ok'] === true && $stale['stale'] === true && $stale['refresh'] === 'failed', json_encode(array('ok' => $stale['ok'], 'stale' => $stale['stale'], 'refresh' => $stale['refresh'], 'error' => $stale['error'])));
    expect($stale['lists']['with-ed']['words'] === array('crane'), 'lost the last good list');
    expect($calls === 2, 'calls after failure ' . $calls);
    $held = wordlebot_serve($manifest, $path, $now + wordlebot_max_age() + 30, true, $fetcher);
    expect($held['refresh'] === 'cooldown' && $calls === 2, json_encode(array('refresh' => $held['refresh'], 'calls' => $calls)));
    @unlink($path);
    @unlink($dir . '/refresh.lock');
    @rmdir($dir);
});

echo $passed . " passed\n";
