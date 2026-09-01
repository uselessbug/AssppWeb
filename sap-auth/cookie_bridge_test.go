package main

import (
	"net/http"
	"testing"
	"time"
)

func TestCookieIdentityReplacesAcrossHostOnlyFlag(t *testing.T) {
	origin := mustURL(t, "https://buy.itunes.apple.com/")

	t.Run("domain to host-only", func(t *testing.T) {
		jar := newTestCookieJar(t)
		jar.SetCookies(origin, []*http.Cookie{{
			Name: "token", Value: "domain", Domain: "buy.itunes.apple.com", Path: "/",
		}})
		jar.SetCookies(origin, []*http.Cookie{{
			Name: "token", Value: "host", Path: "/",
		}})
		cookies := collectCookies(jar, "")
		if len(cookies) != 1 || cookies[0].Value != "host" || !cookies[0].HostOnly {
			t.Fatalf("expected host-only replacement, got %#v", cookies)
		}
	})

	t.Run("host-only to domain", func(t *testing.T) {
		jar := newTestCookieJar(t)
		jar.SetCookies(origin, []*http.Cookie{{
			Name: "token", Value: "host", Path: "/",
		}})
		jar.SetCookies(origin, []*http.Cookie{{
			Name: "token", Value: "domain", Domain: "buy.itunes.apple.com", Path: "/",
		}})
		cookies := collectCookies(jar, "")
		if len(cookies) != 1 || cookies[0].Value != "domain" || cookies[0].HostOnly {
			t.Fatalf("expected domain replacement, got %#v", cookies)
		}
	})
}

func TestCookieIdentityDeletionIgnoresHostOnlyFlag(t *testing.T) {
	origin := mustURL(t, "https://buy.itunes.apple.com/")

	t.Run("domain deleted by host-only", func(t *testing.T) {
		jar := newTestCookieJar(t)
		jar.SetCookies(origin, []*http.Cookie{{
			Name: "token", Value: "domain", Domain: "buy.itunes.apple.com", Path: "/",
		}})
		jar.SetCookies(origin, []*http.Cookie{{
			Name: "token", Value: "", Path: "/", MaxAge: -1,
		}})
		if cookies := collectCookies(jar, ""); len(cookies) != 0 {
			t.Fatalf("domain cookie survived host-only deletion: %#v", cookies)
		}
	})

	t.Run("host-only deleted by domain", func(t *testing.T) {
		jar := newTestCookieJar(t)
		jar.SetCookies(origin, []*http.Cookie{{
			Name: "token", Value: "host", Path: "/",
		}})
		jar.SetCookies(origin, []*http.Cookie{{
			Name: "token", Value: "", Domain: "buy.itunes.apple.com", Path: "/", MaxAge: -1,
		}})
		if cookies := collectCookies(jar, ""); len(cookies) != 0 {
			t.Fatalf("host-only cookie survived domain deletion: %#v", cookies)
		}
	})
}

func TestCollectCookiesRestrictsToBuySessionHosts(t *testing.T) {
	jar := newTestCookieJar(t)

	jar.SetCookies(mustURL(t, "https://init.itunes.apple.com/"), []*http.Cookie{{
		Name: "init-host", Value: "1", Path: "/",
	}})
	jar.SetCookies(mustURL(t, "https://auth.itunes.apple.com/"), []*http.Cookie{{
		Name: "auth-host", Value: "1", Path: "/",
	}})
	jar.SetCookies(mustURL(t, "https://buy.itunes.apple.com/"), []*http.Cookie{{
		Name: "buy-host", Value: "1", Path: "/",
	}})
	jar.SetCookies(mustURL(t, "https://p42-buy.itunes.apple.com/"), []*http.Cookie{{
		Name: "pod-host", Value: "1", Path: "/",
	}})
	jar.SetCookies(mustURL(t, "https://p99-buy.itunes.apple.com/"), []*http.Cookie{{
		Name: "wrong-pod", Value: "1", Path: "/",
	}})
	jar.SetCookies(mustURL(t, "https://buy.itunes.apple.com/"), []*http.Cookie{{
		Name: "shared-domain", Value: "1", Domain: ".itunes.apple.com", Path: "/",
	}})

	expired := inputCookie{
		Name: "expired", Value: "1", Domain: "buy.itunes.apple.com", HostOnly: true,
		Path: "/", ExpiresAt: time.Now().Add(-time.Hour).Unix(),
	}
	jar.metadata[cookieMetadataKey(expired)] = expired

	cookies := collectCookies(jar, "42")
	if len(cookies) != 3 {
		t.Fatalf("expected buy, pod, and shared domain cookies only, got %#v", cookies)
	}

	seen := make(map[string]int)
	for _, cookie := range cookies {
		seen[cookie.Name]++
	}
	for _, name := range []string{"buy-host", "pod-host", "shared-domain"} {
		if seen[name] != 1 {
			t.Fatalf("expected %s exactly once, got %#v", name, cookies)
		}
	}
	for _, name := range []string{"init-host", "auth-host", "wrong-pod", "expired"} {
		if seen[name] != 0 {
			t.Fatalf("unexpected %s in persisted cookies: %#v", name, cookies)
		}
	}
}

func TestCollectCookiesExcludesPodHostWithoutMatchingPod(t *testing.T) {
	jar := newTestCookieJar(t)
	jar.SetCookies(mustURL(t, "https://p42-buy.itunes.apple.com/"), []*http.Cookie{{
		Name: "pod-host", Value: "1", Path: "/",
	}})
	if cookies := collectCookies(jar, ""); len(cookies) != 0 {
		t.Fatalf("pod host-only cookie leaked without a pod: %#v", cookies)
	}
}
