<?php
/* WordleBot list cache. PHP 7.4+. No framework and no secrets.
 * The endpoint in wordlebot.php is the only web entry. This file is the
 * parser, the 24-hour decision, and the locked refresh. Tests include it
 * directly and never serve it.
 *
 * Lists are parsed as data (quoted words). The source is never evaluated.
 */

function wordlebot_max_age() {
    return 86400;
}

function wordlebot_failure_cooldown() {
    return 900;
}

function wordlebot_fetch_timeout() {
    return 12;
}

function wordlebot_fail($error, $words) {
    return array(
        'ok' => false,
        'words' => $words ? $words : array(),
        'count' => $words ? count($words) : 0,
        'error' => $error
    );
}

/* Same rules as src/list-parse.js: a const array of quoted 5-letter words. */
function wordlebot_parse_const_array($source, $length, $minCount, $maxCount) {
    $length = (int) $length;
    $minCount = (int) $minCount;
    $maxCount = (int) $maxCount;
    if ($length < 1) return wordlebot_fail('Word length must be at least 1', array());
    if ($source === null || $source === '') return wordlebot_fail('Empty response', array());
    if (!is_string($source)) return wordlebot_fail('Empty response', array());
    if (strlen($source) > 2000000) return wordlebot_fail('Response is too large to be a word list', array());
    $head = $source;
    if (substr($head, 0, 3) === "\xEF\xBB\xBF") $head = substr($head, 3);
    $sniff = strtolower(substr($head, 0, 400));
    if (strpos($sniff, '<!doctype') !== false || strpos($sniff, '<html') !== false) {
        return wordlebot_fail('Response was HTML, not a word list', array());
    }
    if (!preg_match('/const\s+[A-Za-z_$][\w$]*\s*=\s*\[/', $source, $assign, PREG_OFFSET_CAPTURE)) {
        return wordlebot_fail('Not a const array of words', array());
    }
    $start = strpos($source, '[', $assign[0][1]);
    $end = strrpos($source, ']');
    if ($start === false || $end === false || $end < $start) {
        return wordlebot_fail('No array found', array());
    }
    $body = substr($source, $start, $end - $start + 1);
    if (!preg_match_all('/["\']([^"\'\\\\\r\n]*)["\']/', $body, $found)) {
        return wordlebot_fail('Parsed 0 words, expected at least ' . $minCount, array());
    }
    $words = array();
    $seen = array();
    $bad = 0;
    foreach ($found[1] as $raw) {
        if (!preg_match('/^[A-Za-z]{' . $length . '}$/', $raw)) {
            $bad++;
            continue;
        }
        $word = strtolower($raw);
        if (isset($seen[$word])) continue;
        $seen[$word] = true;
        $words[] = $word;
    }
    if ($bad) {
        $suffix = $bad === 1 ? ' is' : 's are';
        return wordlebot_fail($bad . ' quoted value' . $suffix . ' not ' . $length . ' letters', $words);
    }
    if (count($words) < $minCount) {
        return wordlebot_fail('Parsed ' . count($words) . ' words, expected at least ' . $minCount, $words);
    }
    if ($maxCount && count($words) > $maxCount) {
        return wordlebot_fail('Parsed ' . count($words) . ' words, above the expected maximum ' . $maxCount, $words);
    }
    return array('ok' => true, 'words' => $words, 'count' => count($words), 'error' => '');
}

function wordlebot_cache_usable($cache) {
    return is_array($cache) && !empty($cache['lastChecked']) && !empty($cache['lists']) && is_array($cache['lists']);
}

/* 'serve' keeps the file. 'refresh' may contact GitHub.
 * A fresh file (lastChecked within $maxAge) is never refreshed, even when
 * the visitor asked. A stale file with a failed attempt inside $cooldown
 * is served again so a downed upstream is not hit on every page view.
 */
function wordlebot_plan($cache, $now, $maxAge, $cooldown, $asked) {
    $now = (int) $now;
    $maxAge = (int) $maxAge;
    $cooldown = (int) $cooldown;
    $usable = wordlebot_cache_usable($cache);
    if ($usable && ($now - (int) $cache['lastChecked']) < $maxAge) {
        return array('action' => 'serve', 'refresh' => $asked ? 'not-due' : 'cached');
    }
    if ($usable && !empty($cache['error']) && !empty($cache['lastAttempt'])) {
        if (($now - (int) $cache['lastAttempt']) < $cooldown) {
            return array('action' => 'serve', 'refresh' => 'cooldown');
        }
    }
    return array('action' => 'refresh', 'refresh' => 'fetched');
}

function wordlebot_read_json($path) {
    if (!is_file($path)) return null;
    $raw = @file_get_contents($path);
    if ($raw === false || $raw === '') return null;
    $data = json_decode($raw, true);
    if (!is_array($data)) return null;
    return $data;
}

function wordlebot_write_json($path, $data) {
    $dir = dirname($path);
    if (!is_dir($dir) && !@mkdir($dir, 0775, true)) return false;
    $json = json_encode($data);
    if ($json === false) return false;
    $tmp = $dir . '/cache-' . getmypid() . '-' . bin2hex(random_bytes(4)) . '.tmp';
    if (file_put_contents($tmp, $json, LOCK_EX) === false) {
        @unlink($tmp);
        return false;
    }
    if (!@rename($tmp, $path)) {
        @unlink($tmp);
        return false;
    }
    return true;
}

function wordlebot_http_get($url, $timeout) {
    $timeout = (int) $timeout;
    if ($timeout < 1) $timeout = 12;
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        if ($ch === false) return array('ok' => false, 'error' => 'curl failed to start', 'body' => '');
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, $timeout);
        curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
        curl_setopt($ch, CURLOPT_USERAGENT, 'geekahedron-solver-wordlebot/1.0');
        $body = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($body === false || $code < 200 || $code >= 300) {
            $why = $err !== '' ? $err : ('HTTP ' . $code);
            return array('ok' => false, 'error' => $why, 'body' => '');
        }
        return array('ok' => true, 'error' => '', 'body' => $body);
    }
    $context = stream_context_create(array(
        'http' => array(
            'timeout' => $timeout,
            'ignore_errors' => true,
            'header' => "User-Agent: geekahedron-solver-wordlebot/1.0\r\n"
        )
    ));
    $body = @file_get_contents($url, false, $context);
    $code = 0;
    if (isset($http_response_header) && is_array($http_response_header)) {
        foreach ($http_response_header as $line) {
            if (preg_match('/^HTTP\/\S+\s+(\d+)/', $line, $m)) $code = (int) $m[1];
        }
    }
    if ($body === false || $code < 200 || $code >= 300) {
        return array('ok' => false, 'error' => $body === false ? 'request failed' : ('HTTP ' . $code), 'body' => '');
    }
    return array('ok' => true, 'error' => '', 'body' => $body);
}

function wordlebot_specs($manifest) {
    $out = array();
    if (!is_array($manifest) || empty($manifest['remote'])) return $out;
    $groups = array('answers', 'guesses');
    foreach ($groups as $group) {
        if (empty($manifest['remote'][$group]) || !is_array($manifest['remote'][$group])) continue;
        foreach ($manifest['remote'][$group] as $spec) {
            if (!is_array($spec) || empty($spec['id']) || empty($spec['url'])) continue;
            $out[] = $spec;
        }
    }
    return $out;
}

function wordlebot_public_list($spec, $words) {
    return array(
        'id' => $spec['id'],
        'label' => isset($spec['label']) ? $spec['label'] : $spec['id'],
        'file' => isset($spec['file']) ? $spec['file'] : '',
        'url' => $spec['url'],
        'count' => count($words),
        'words' => array_values($words)
    );
}

function wordlebot_fetch_lists($specs, $timeout) {
    $lists = array();
    foreach ($specs as $spec) {
        $res = wordlebot_http_get($spec['url'], $timeout);
        if (!$res['ok']) {
            $file = isset($spec['file']) ? $spec['file'] : $spec['id'];
            return array('ok' => false, 'error' => $file . ': ' . $res['error'], 'lists' => array());
        }
        $min = isset($spec['minCount']) ? (int) $spec['minCount'] : 1;
        $max = isset($spec['maxCount']) ? (int) $spec['maxCount'] : 0;
        $parsed = wordlebot_parse_const_array($res['body'], 5, $min, $max);
        if (!$parsed['ok']) {
            $file = isset($spec['file']) ? $spec['file'] : $spec['id'];
            return array('ok' => false, 'error' => $file . ': ' . $parsed['error'], 'lists' => array());
        }
        $lists[$spec['id']] = wordlebot_public_list($spec, $parsed['words']);
    }
    return array('ok' => true, 'error' => '', 'lists' => $lists);
}

function wordlebot_payload($cache, $origin, $refresh, $stored) {
    $lists = ($cache && isset($cache['lists'])) ? $cache['lists'] : null;
    return array(
        'ok' => $lists ? true : false,
        'origin' => $origin,
        'stale' => $origin === 'cache' && !empty($cache['error']),
        'stored' => $stored ? true : false,
        'refresh' => $refresh,
        'lastChecked' => ($cache && !empty($cache['lastChecked'])) ? (int) $cache['lastChecked'] : null,
        'lastUpdated' => ($cache && !empty($cache['lastUpdated'])) ? (int) $cache['lastUpdated'] : null,
        'lastAttempt' => ($cache && !empty($cache['lastAttempt'])) ? (int) $cache['lastAttempt'] : null,
        'error' => ($cache && !empty($cache['error'])) ? $cache['error'] : null,
        'maxAgeSeconds' => wordlebot_max_age(),
        'lists' => $lists
    );
}

/* $fetcher($specs, $timeout) is injectable so tests do not touch the network.
 * Returns the JSON-ready payload.
 */
function wordlebot_serve($manifest, $cachePath, $now, $asked, $fetcher) {
    $now = (int) $now;
    $specs = wordlebot_specs($manifest);
    $cache = wordlebot_read_json($cachePath);
    $plan = wordlebot_plan($cache, $now, wordlebot_max_age(), wordlebot_failure_cooldown(), $asked);
    if ($plan['action'] === 'serve') {
        return wordlebot_payload($cache, 'cache', $plan['refresh'], true);
    }

    $dir = dirname($cachePath);
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    $lockPath = $dir . '/refresh.lock';
    $lock = @fopen($lockPath, 'c');
    if ($lock) flock($lock, LOCK_EX);
    $cache = wordlebot_read_json($cachePath);
    $plan = wordlebot_plan($cache, $now, wordlebot_max_age(), wordlebot_failure_cooldown(), $asked);
    if ($plan['action'] === 'serve') {
        if ($lock) {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
        return wordlebot_payload($cache, 'cache', $plan['refresh'], true);
    }

    $fetched = call_user_func($fetcher, $specs, wordlebot_fetch_timeout());
    if (!empty($fetched['ok'])) {
        $next = array(
            'lastChecked' => $now,
            'lastUpdated' => $now,
            'lastAttempt' => $now,
            'error' => null,
            'lists' => $fetched['lists']
        );
        $stored = wordlebot_write_json($cachePath, $next);
        if ($lock) {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
        return wordlebot_payload($next, 'github', 'fetched', $stored);
    }

    $error = !empty($fetched['error']) ? $fetched['error'] : 'fetch failed';
    if (wordlebot_cache_usable($cache)) {
        $cache['lastAttempt'] = $now;
        $cache['error'] = $error;
        $stored = wordlebot_write_json($cachePath, $cache);
        if ($lock) {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
        return wordlebot_payload($cache, 'cache', 'failed', $stored);
    }

    $empty = array(
        'lastChecked' => null,
        'lastUpdated' => null,
        'lastAttempt' => $now,
        'error' => $error,
        'lists' => null
    );
    if ($lock) {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
    $payload = wordlebot_payload($empty, 'none', 'failed', false);
    $payload['ok'] = false;
    $payload['lists'] = null;
    return $payload;
}
