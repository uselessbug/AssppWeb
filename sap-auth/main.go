package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/majd/ipatool/v2/pkg/appstore"
	apphttp "github.com/majd/ipatool/v2/pkg/http"
	"github.com/majd/ipatool/v2/pkg/util/operatingsystem"
)

type inputCookie struct {
	Name      string `json:"name"`
	Value     string `json:"value"`
	Path      string `json:"path"`
	Domain    string `json:"domain,omitempty"`
	HostOnly  bool   `json:"hostOnly,omitempty"`
	ExpiresAt int64  `json:"expiresAt,omitempty"`
	HTTPOnly  bool   `json:"httpOnly"`
	Secure    bool   `json:"secure"`
}

type request struct {
	Email           string        `json:"email"`
	Password        string        `json:"password"`
	AuthCode        string        `json:"authCode,omitempty"`
	DeviceID        string        `json:"deviceId"`
	ExistingCookies []inputCookie `json:"existingCookies,omitempty"`
}

type accountResponse struct {
	Email                       string        `json:"email"`
	AppleID                     string        `json:"appleId"`
	Store                       string        `json:"store"`
	FirstName                   string        `json:"firstName"`
	LastName                    string        `json:"lastName"`
	PasswordToken               string        `json:"passwordToken"`
	DirectoryServicesIdentifier string        `json:"directoryServicesIdentifier"`
	Cookies                     []inputCookie `json:"cookies"`
	DeviceIdentifier            string        `json:"deviceIdentifier"`
	Pod                         string        `json:"pod,omitempty"`
}

type response struct {
	Account               *accountResponse `json:"account,omitempty"`
	Error                 string           `json:"error,omitempty"`
	Kind                  string           `json:"kind,omitempty"`
	CodeRequired          bool             `json:"codeRequired,omitempty"`
	EligibleForFreshRetry bool             `json:"eligibleForFreshRetry,omitempty"`
}

type memoryKeychain struct{}

func (memoryKeychain) Get(string) ([]byte, error) { return nil, errors.New("not found") }
func (memoryKeychain) Set(string, []byte) error   { return nil }
func (memoryKeychain) Remove(string) error        { return nil }

type fixedMachine struct{ deviceID string }

func (m fixedMachine) MacAddress() (string, error) {
	if _, err := hex.DecodeString(m.deviceID); err != nil || len(m.deviceID) != 12 {
		return "", errors.New("device ID must contain 12 hexadecimal characters")
	}
	parts := make([]string, 0, 6)
	for index := 0; index < len(m.deviceID); index += 2 {
		parts = append(parts, m.deviceID[index:index+2])
	}
	return strings.Join(parts, ":"), nil
}
func (fixedMachine) HomeDirectory() string            { return os.TempDir() }
func (fixedMachine) ReadPassword(int) ([]byte, error) { return nil, errors.New("unsupported") }

type memoryCookieJar struct {
	*cookiejar.Jar
	metadata map[string]inputCookie
}

func newMemoryCookieJar(jar *cookiejar.Jar) *memoryCookieJar {
	return &memoryCookieJar{Jar: jar, metadata: make(map[string]inputCookie)}
}

func (*memoryCookieJar) Save() error { return nil }

func (j *memoryCookieJar) SetCookies(origin *url.URL, cookies []*http.Cookie) {
	j.Jar.SetCookies(origin, cookies)
	j.rememberCookies(origin, cookies, time.Now())
}

func (j *memoryCookieJar) rememberCookies(origin *url.URL, cookies []*http.Cookie, now time.Time) {
	host := strings.ToLower(origin.Hostname())
	if host == "" {
		return
	}
	for _, cookie := range cookies {
		if cookie == nil || cookie.Name == "" {
			continue
		}

		domain := canonicalCookieDomain(cookie.Domain)
		hostOnly := domain == ""
		if hostOnly {
			domain = host
		}
		path := cookie.Path
		if path == "" || !strings.HasPrefix(path, "/") {
			path = defaultCookiePath(origin.Path)
		}

		expiresAt := int64(0)
		deleteCookie := cookie.MaxAge < 0
		if cookie.MaxAge > 0 {
			expiresAt = now.Add(time.Duration(cookie.MaxAge) * time.Second).Unix()
		} else if !cookie.Expires.IsZero() {
			expiresAt = cookie.Expires.Unix()
			deleteCookie = deleteCookie || !cookie.Expires.After(now)
		}

		metadata := inputCookie{
			Name:      cookie.Name,
			Value:     cookie.Value,
			Path:      path,
			Domain:    domain,
			HostOnly:  hostOnly,
			ExpiresAt: expiresAt,
			HTTPOnly:  cookie.HttpOnly,
			Secure:    cookie.Secure,
		}
		key := cookieMetadataKey(metadata)
		if deleteCookie {
			delete(j.metadata, key)
			continue
		}
		j.metadata[key] = metadata
	}
}

func canonicalCookieDomain(domain string) string {
	return strings.TrimPrefix(strings.ToLower(strings.TrimSpace(domain)), ".")
}

func cookieMetadataKey(cookie inputCookie) string {
	return strings.Join([]string{
		cookie.Name,
		canonicalCookieDomain(cookie.Domain),
		cookie.Path,
	}, "|")
}

func defaultCookiePath(requestPath string) string {
	if requestPath == "" || !strings.HasPrefix(requestPath, "/") {
		return "/"
	}
	lastSlash := strings.LastIndex(requestPath, "/")
	if lastSlash <= 0 {
		return "/"
	}
	return requestPath[:lastSlash]
}

func main() {
	encoder := json.NewEncoder(os.Stdout)
	var payload request
	if err := json.NewDecoder(os.Stdin).Decode(&payload); err != nil {
		_ = encoder.Encode(response{Error: "invalid request", Kind: "request"})
		return
	}

	payload.Email = strings.TrimSpace(payload.Email)
	payload.DeviceID = strings.ToLower(strings.TrimSpace(payload.DeviceID))
	if payload.Email == "" || payload.Password == "" || !validDeviceID(payload.DeviceID) {
		_ = encoder.Encode(response{
			Error: "Apple ID, password, and a 12-character device ID are required",
			Kind:  "request",
		})
		return
	}

	jar, err := cookiejar.New(nil)
	if err != nil {
		_ = encoder.Encode(response{
			Error: "failed to initialize authentication session",
			Kind:  "infrastructure",
		})
		return
	}
	cookieJar := newMemoryCookieJar(jar)
	seedCookies(cookieJar, payload.ExistingCookies)

	store := appstore.NewAppStore(appstore.Args{
		CookieJar:       cookieJar,
		OperatingSystem: operatingsystem.New(),
		Keychain:        memoryKeychain{},
		Machine:         fixedMachine{deviceID: payload.DeviceID},
	})

	result, err := login(store, payload)
	if err != nil {
		codeRequired := errors.Is(err, appstore.ErrAuthCodeRequired)
		kind, eligibleForFreshRetry := classifyLoginError(err)
		errorMessage := "Apple authentication failed"
		if codeRequired {
			errorMessage = "Verification code required"
		}
		_ = encoder.Encode(response{
			Error:                 errorMessage,
			Kind:                  kind,
			CodeRequired:          codeRequired,
			EligibleForFreshRetry: eligibleForFreshRetry,
		})
		return
	}

	account := result.Account
	firstName, lastName := splitName(account.Name)
	output := accountResponse{
		Email:                       payload.Email,
		AppleID:                     account.Email,
		Store:                       account.StoreFront,
		FirstName:                   firstName,
		LastName:                    lastName,
		PasswordToken:               account.PasswordToken,
		DirectoryServicesIdentifier: account.DirectoryServicesID,
		Cookies:                     collectCookies(cookieJar, account.Pod),
		DeviceIdentifier:            payload.DeviceID,
		Pod:                         account.Pod,
	}
	_ = encoder.Encode(response{Account: &output})
}

// Authentication intentionally has a strict upper bound of one ipatool login
// call. Cached-session -> fresh-session fallback is owned by the frontend.
const maxLoginAttempts = 1

func login(store appstore.AppStore, payload request) (appstore.LoginOutput, error) {
	input := appstore.LoginInput{
		Email:    payload.Email,
		Password: payload.Password,
		AuthCode: strings.ReplaceAll(payload.AuthCode, " ", ""),
	}

	var result appstore.LoginOutput
	var err error
	for attempt := 0; attempt < maxLoginAttempts; attempt++ {
		result, err = store.Login(input)
	}
	return result, err
}

func classifyLoginError(err error) (string, bool) {
	if errors.Is(err, appstore.ErrAuthCodeRequired) {
		return "authentication", false
	}

	var appStoreError *appstore.Error
	if !errors.As(err, &appStoreError) {
		return "infrastructure", false
	}

	failureType, customerMessage := appStoreErrorSemantics(appStoreError)
	if failureType == appstore.FailureTypeInvalidCredentials {
		return "authentication", false
	}
	if failureType != "" {
		return "authentication", true
	}
	if customerMessage != "" {
		return "authentication", false
	}
	return "infrastructure", false
}

func appStoreErrorSemantics(err *appstore.Error) (string, string) {
	encoded, marshalErr := json.Marshal(err.Metadata)
	if marshalErr != nil {
		return "", ""
	}
	var metadata struct {
		Data struct {
			FailureType     string
			CustomerMessage string
		}
	}
	if unmarshalErr := json.Unmarshal(encoded, &metadata); unmarshalErr != nil {
		return "", ""
	}
	return metadata.Data.FailureType, metadata.Data.CustomerMessage
}

func validDeviceID(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == 6
}

func seedCookies(jar apphttp.CookieJar, cookies []inputCookie) {
	now := time.Now().Unix()
	for _, cookie := range cookies {
		if cookie.Name == "" || (cookie.ExpiresAt != 0 && cookie.ExpiresAt <= now) {
			continue
		}
		host := canonicalCookieDomain(cookie.Domain)
		if host == "" {
			host = "buy.itunes.apple.com"
		}
		origin, err := url.Parse("https://" + host + "/")
		if err != nil {
			continue
		}
		path := cookie.Path
		if path == "" {
			path = "/"
		}
		domain := cookie.Domain
		if cookie.HostOnly || cookie.Domain == "" {
			domain = ""
		}
		httpCookie := &http.Cookie{
			Name: cookie.Name, Value: cookie.Value, Path: path,
			Domain: domain, HttpOnly: cookie.HTTPOnly, Secure: cookie.Secure,
		}
		if cookie.ExpiresAt != 0 {
			httpCookie.Expires = time.Unix(cookie.ExpiresAt, 0)
		}
		jar.SetCookies(origin, []*http.Cookie{httpCookie})
	}
}

func cookieAppliesToHost(cookie inputCookie, host string) bool {
	domain := canonicalCookieDomain(cookie.Domain)
	host = strings.ToLower(host)
	if domain == "" || host == "" {
		return false
	}
	if cookie.HostOnly {
		return domain == host
	}
	return domain == host || strings.HasSuffix(host, "."+domain)
}

func collectCookies(jar *memoryCookieJar, pod string) []inputCookie {
	hosts := []string{"buy.itunes.apple.com"}
	if pod != "" {
		hosts = append(hosts, "p"+pod+"-buy.itunes.apple.com")
	}

	now := time.Now().Unix()
	keys := make([]string, 0, len(jar.metadata))
	for key, cookie := range jar.metadata {
		if cookie.ExpiresAt != 0 && cookie.ExpiresAt <= now {
			delete(jar.metadata, key)
			continue
		}
		applies := false
		for _, host := range hosts {
			if cookieAppliesToHost(cookie, host) {
				applies = true
				break
			}
		}
		if applies {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	result := make([]inputCookie, 0, len(keys))
	for _, key := range keys {
		result = append(result, jar.metadata[key])
	}
	return result
}

func splitName(name string) (string, string) {
	parts := strings.Fields(name)
	if len(parts) == 0 {
		return "", ""
	}
	return parts[0], strings.Join(parts[1:], " ")
}
