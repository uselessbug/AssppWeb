package main

import (
	"errors"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"testing"
	"time"

	"github.com/majd/ipatool/v2/pkg/appstore"
)

func TestValidDeviceID(t *testing.T) {
	for _, value := range []string{"aabbccddeeff", "02abcdef1234"} {
		if !validDeviceID(value) {
			t.Fatalf("expected %q to be valid", value)
		}
	}
	for _, value := range []string{"", "aabb", "ggbbccddeeff", "aa:bb:cc:dd:ee:ff"} {
		if validDeviceID(value) {
			t.Fatalf("expected %q to be invalid", value)
		}
	}
}

func TestFixedMachineMacAddress(t *testing.T) {
	mac, err := (fixedMachine{deviceID: "02abcdef1234"}).MacAddress()
	if err != nil {
		t.Fatal(err)
	}
	if mac != "02:ab:cd:ef:12:34" {
		t.Fatalf("unexpected MAC address %q", mac)
	}
}

func TestLoginAttemptBound(t *testing.T) {
	if maxLoginAttempts != 1 {
		t.Fatalf("helper login attempts must remain 1, got %d", maxLoginAttempts)
	}
}

func TestClassifyLoginError(t *testing.T) {
	invalidCredentialsMetadata := map[string]any{
		"Data": map[string]any{"FailureType": appstore.FailureTypeInvalidCredentials},
	}
	retryableFailureMetadata := map[string]any{
		"Data": map[string]any{"FailureType": appstore.FailureTypePasswordTokenExpired},
	}
	messageMetadata := map[string]any{
		"Data": map[string]any{"CustomerMessage": appstore.CustomerMessageAccountDisabled},
	}

	tests := []struct {
		name     string
		err      error
		kind     string
		eligible bool
	}{
		{"2FA challenge", appstore.ErrAuthCodeRequired, "authentication", false},
		{"invalid credentials", appstore.NewErrorWithMetadata(errors.New("failed"), invalidCredentialsMetadata), "authentication", false},
		{"retryable Apple failure type", appstore.NewErrorWithMetadata(errors.New("failed"), retryableFailureMetadata), "authentication", true},
		{"Apple customer message", appstore.NewErrorWithMetadata(errors.New("failed"), messageMetadata), "authentication", false},
		{"malformed Apple response", appstore.NewErrorWithMetadata(errors.New("failed"), map[string]any{}), "infrastructure", false},
		{"transport failure", errors.New("request failed"), "infrastructure", false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			kind, eligible := classifyLoginError(test.err)
			if kind != test.kind || eligible != test.eligible {
				t.Fatalf("got (%q, %v), want (%q, %v)", kind, eligible, test.kind, test.eligible)
			}
		})
	}
}

func newTestCookieJar(t *testing.T) *memoryCookieJar {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return newMemoryCookieJar(jar)
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func findCookie(t *testing.T, cookies []inputCookie, name, path string) inputCookie {
	t.Helper()
	for _, cookie := range cookies {
		if cookie.Name == name && cookie.Path == path {
			return cookie
		}
	}
	t.Fatalf("cookie %s %s not found in %#v", name, path, cookies)
	return inputCookie{}
}

func TestCookieRoundTripPreservesExpiry(t *testing.T) {
	jar := newTestCookieJar(t)
	expires := time.Now().Add(2 * time.Hour).Truncate(time.Second)
	jar.SetCookies(mustURL(t, "https://buy.itunes.apple.com/WebObjects/"), []*http.Cookie{{
		Name: "persistent", Value: "value", Path: "/", Expires: expires,
	}})
	cookie := findCookie(t, collectCookies(jar, ""), "persistent", "/")
	if cookie.ExpiresAt != expires.Unix() {
		t.Fatalf("expiry changed: got %d want %d", cookie.ExpiresAt, expires.Unix())
	}
}

func TestCookieRoundTripPreservesDomainCookie(t *testing.T) {
	jar := newTestCookieJar(t)
	jar.SetCookies(mustURL(t, "https://buy.itunes.apple.com/"), []*http.Cookie{{
		Name: "domain", Value: "value", Domain: ".itunes.apple.com", Path: "/",
	}})
	cookie := findCookie(t, collectCookies(jar, ""), "domain", "/")
	if cookie.Domain != "itunes.apple.com" || cookie.HostOnly {
		t.Fatalf("unexpected domain metadata: %#v", cookie)
	}
}

func TestCookieRoundTripPreservesHostOnly(t *testing.T) {
	jar := newTestCookieJar(t)
	jar.SetCookies(mustURL(t, "https://buy.itunes.apple.com/"), []*http.Cookie{{
		Name: "host", Value: "value", Path: "/",
	}})
	cookie := findCookie(t, collectCookies(jar, ""), "host", "/")
	if cookie.Domain != "buy.itunes.apple.com" || !cookie.HostOnly {
		t.Fatalf("unexpected host-only metadata: %#v", cookie)
	}
}

func TestCookieRoundTripPreservesSameNameDifferentPaths(t *testing.T) {
	jar := newTestCookieJar(t)
	origin := mustURL(t, "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/buyProduct")
	jar.SetCookies(origin, []*http.Cookie{
		{Name: "token", Value: "root", Path: "/"},
		{Name: "token", Value: "finance", Path: "/WebObjects"},
	})
	cookies := collectCookies(jar, "")
	if len(cookies) != 2 {
		t.Fatalf("expected both path variants, got %#v", cookies)
	}
	if findCookie(t, cookies, "token", "/").Value != "root" || findCookie(t, cookies, "token", "/WebObjects").Value != "finance" {
		t.Fatalf("path variants changed: %#v", cookies)
	}
}

func TestCookieRoundTripPreservesSecureHTTPOnly(t *testing.T) {
	jar := newTestCookieJar(t)
	jar.SetCookies(mustURL(t, "https://buy.itunes.apple.com/"), []*http.Cookie{{
		Name: "flags", Value: "value", Path: "/", Secure: true, HttpOnly: true,
	}})
	cookie := findCookie(t, collectCookies(jar, ""), "flags", "/")
	if !cookie.Secure || !cookie.HTTPOnly {
		t.Fatalf("cookie flags changed: %#v", cookie)
	}
}

func TestCookieRoundTripDropsExpiredAndDeleted(t *testing.T) {
	jar := newTestCookieJar(t)
	origin := mustURL(t, "https://buy.itunes.apple.com/")
	jar.SetCookies(origin, []*http.Cookie{{
		Name: "expired", Value: "old", Path: "/", Expires: time.Now().Add(-time.Hour),
	}})
	jar.SetCookies(origin, []*http.Cookie{{Name: "deleted", Value: "live", Path: "/"}})
	jar.SetCookies(origin, []*http.Cookie{{Name: "deleted", Value: "", Path: "/", MaxAge: -1}})
	if cookies := collectCookies(jar, ""); len(cookies) != 0 {
		t.Fatalf("expired/deleted cookies leaked: %#v", cookies)
	}
}

func TestDomainCookieIsNotDuplicatedAcrossBuyAndPodHosts(t *testing.T) {
	jar := newTestCookieJar(t)
	jar.SetCookies(mustURL(t, "https://buy.itunes.apple.com/"), []*http.Cookie{{
		Name: "shared", Value: "value", Domain: ".itunes.apple.com", Path: "/",
	}})
	cookies := collectCookies(jar, "42")
	if len(cookies) != 1 || cookies[0].Domain != "itunes.apple.com" || cookies[0].HostOnly {
		t.Fatalf("domain cookie duplicated or rebound: %#v", cookies)
	}
}

func TestSeedCookiesSkipsExpiredCookies(t *testing.T) {
	jar := newTestCookieJar(t)
	seedCookies(jar, []inputCookie{
		{
			Name:      "expired",
			Value:     "old",
			Domain:    "buy.itunes.apple.com",
			HostOnly:  true,
			Path:      "/",
			ExpiresAt: time.Now().Add(-time.Hour).Unix(),
		},
		{
			Name:      "valid",
			Value:     "new",
			Domain:    "buy.itunes.apple.com",
			HostOnly:  true,
			Path:      "/",
			ExpiresAt: time.Now().Add(time.Hour).Unix(),
		},
	})

	cookies := jar.Cookies(mustURL(t, "https://buy.itunes.apple.com/"))
	if len(cookies) != 1 || cookies[0].Name != "valid" || cookies[0].Value != "new" {
		t.Fatalf("unexpected seeded cookies: %#v", cookies)
	}
}
