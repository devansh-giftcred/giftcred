import json
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import httpx
from oauthlib.oauth1 import Client as OAuth1Client
from sqlalchemy.orm import Session
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from config import Settings, get_settings
from logger import get_logger
from models import Category, OAuthToken, Subcategory

logger = get_logger(__name__)


class WoohooAuthError(Exception):
    """OAuth authentication failed."""


class WoohooAPIError(Exception):
    """Woohoo API request failed."""


@dataclass
class TokenPair:
    oauth_token: str
    oauth_token_secret: str


@dataclass
class HTTPDebugResponse:
    status_code: int
    headers: Dict[str, str]
    body: str

    def print_debug(self, label: str) -> None:
        print(f"\n{'=' * 60}")
        print(f"DEBUG: {label}")
        print(f"{'=' * 60}")
        print(f"Status Code: {self.status_code}")
        print("Headers:")
        for key, value in self.headers.items():
            print(f"  {key}: {value}")
        print("Body:")
        print(self.body)
        print(f"{'=' * 60}\n")


class WoohooClient:
    INITIATE_PATH = "/oauth/initiate"
    AUTHORIZE_PATH = "/oauth/authorize/customerVerifier"
    TOKEN_PATH = "/oauth/token"
    CATEGORIES_PATH = "/rest/v3/catalog/categories"
    SUBCATEGORIES_PATH = "/rest/v3/catalog/categories/{category_id}/subcategories"

    def __init__(
        self,
        settings: Optional[Settings] = None,
        responses_dir: Optional[Path] = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.base_url = self.settings.base_url
        self.timeout = self.settings.woohoo_request_timeout
        self.max_retries = self.settings.woohoo_max_retries
        self.responses_dir = responses_dir or Path(__file__).resolve().parent / "responses"
        self.responses_dir.mkdir(parents=True, exist_ok=True)
        self._access_token: Optional[TokenPair] = None

    # ------------------------------------------------------------------ OAuth
    def authenticate(self, session: Session, force: bool = False) -> TokenPair:
        if not force:
            stored = self._load_token_from_db(session)
            if stored:
                self._access_token = stored
                logger.info("Reusing stored OAuth access token from database")
                return stored

        logger.info("Starting OAuth 1.0a authentication flow")
        request_token = self._get_request_token()
        verifier = self._authorize_request_token(request_token)
        access_token = self._exchange_access_token(request_token, verifier)
        self._save_token_to_db(session, access_token)
        self._access_token = access_token
        logger.info("OAuth authentication completed successfully")
        return access_token

    def _get_request_token(self) -> TokenPair:
        url = f"{self.base_url}{self.INITIATE_PATH}"
        response = self._consumer_signed_request("GET", url, step_name="request_token")
        response.print_debug("Request Token Response")

        if response.status_code >= 400:
            raise WoohooAuthError(
                f"Request token failed with HTTP {response.status_code}: {response.body}"
            )

        parsed = dict(parse_qsl(response.body))
        token = parsed.get("oauth_token")
        secret = parsed.get("oauth_token_secret")
        if not token or not secret:
            raise WoohooAuthError(f"Invalid request token response: {response.body}")

        self._save_response("01_request_token", {"parsed": parsed, "raw": response.body})
        return TokenPair(oauth_token=token, oauth_token_secret=secret)

    def _authorize_request_token(self, request_token: TokenPair) -> str:
        url = f"{self.base_url}{self.AUTHORIZE_PATH}?oauth_token={request_token.oauth_token}"
        form_data = {
            "username": self.settings.woohoo_username,
            "password": self.settings.woohoo_password,
        }
        response = self._unsigned_request(
            "POST",
            url,
            data=form_data,
            step_name="verifier",
        )
        response.print_debug("Verifier Response")

        if response.status_code >= 400:
            raise WoohooAuthError(
                f"Authorization failed with HTTP {response.status_code}: {response.body}"
            )

        verifier = self._extract_verifier(response.body)
        if not verifier:
            raise WoohooAuthError(f"Verifier missing from authorization response: {response.body}")

        self._save_response("02_verifier", {"verifier": verifier, "raw": response.body})
        return verifier

    def _exchange_access_token(self, request_token: TokenPair, verifier: str) -> TokenPair:
        url = f"{self.base_url}{self.TOKEN_PATH}"
        response = self._signed_request(
            "POST",
            url,
            token=request_token,
            verifier=verifier,
            step_name="access_token",
        )
        response.print_debug("Access Token Response")

        if response.status_code >= 400:
            raise WoohooAuthError(
                f"Access token exchange failed with HTTP {response.status_code}: {response.body}"
            )

        parsed = dict(parse_qsl(response.body))
        token = parsed.get("oauth_token")
        secret = parsed.get("oauth_token_secret")
        if not token or not secret:
            raise WoohooAuthError(f"Invalid access token response: {response.body}")

        self._save_response("03_access_token", {"parsed": parsed, "raw": response.body})
        return TokenPair(oauth_token=token, oauth_token_secret=secret)

    # ------------------------------------------------------------------ Catalog
    def fetch_all_categories(self) -> List[Dict[str, Any]]:
        token = self._require_access_token()
        response = self._catalog_request(
            "GET",
            f"{self.base_url}{self.CATEGORIES_PATH}",
            token=token,
            step_name="catalog_categories",
        )
        response.print_debug("Catalog Categories API Response")

        if response.status_code >= 400:
            raise WoohooAPIError(
                f"Catalog fetch failed with HTTP {response.status_code}: {response.body}"
            )

        payload = self._parse_json(response.body)
        self._save_response("04_catalog_categories", payload)
        return self._normalize_category_list(payload)

    def fetch_subcategories(self, category_id: str) -> List[Dict[str, Any]]:
        path = self.SUBCATEGORIES_PATH.format(category_id=category_id)
        token = self._require_access_token()
        response = self._catalog_request(
            "GET",
            f"{self.base_url}{path}",
            token=token,
            step_name=f"subcategories_{category_id}",
        )
        response.print_debug(f"Subcategories API Response (category={category_id})")

        if response.status_code == 404:
            logger.info("No dedicated subcategory endpoint for category %s (404)", category_id)
            return []

        if response.status_code >= 400:
            raise WoohooAPIError(
                f"Subcategory fetch failed for {category_id}: HTTP {response.status_code}: {response.body}"
            )

        payload = self._parse_json(response.body)
        self._save_response(f"05_subcategories_{category_id}", payload)
        return self._normalize_subcategory_list(payload)

    def _catalog_request(
        self,
        method: str,
        url: str,
        *,
        token: TokenPair,
        json_body: Optional[Dict[str, Any]] = None,
        step_name: str,
    ) -> HTTPDebugResponse:
        """Try catalog request; on 401 inspect response and retry with extra headers."""
        response = self._signed_request(method, url, token=token, json_body=json_body, step_name=step_name)
        if response.status_code != 401:
            return response

        logger.warning("Catalog API returned 401 — inspecting response for required headers")
        self._analyze_401_response(response)

        date_header = self._build_date_at_client()
        logger.info("Retrying catalog request with dateAtClient header: %s", date_header)
        response = self._signed_request(
            method,
            url,
            token=token,
            json_body=json_body,
            extra_headers={"dateAtClient": date_header},
            step_name=f"{step_name}_with_dateAtClient",
        )
        if response.status_code != 401:
            return response

        logger.warning("Catalog still returned 401 after dateAtClient — retrying with signature header")
        signature = self._build_signature_header(url, method, date_header)
        response = self._signed_request(
            method,
            url,
            token=token,
            json_body=json_body,
            extra_headers={
                "dateAtClient": date_header,
                "signature": signature,
            },
            step_name=f"{step_name}_with_dateAtClient_signature",
        )
        return response

    def _analyze_401_response(self, response: HTTPDebugResponse) -> None:
        print("\n401 ANALYSIS")
        print(f"Status: {response.status_code}")
        print("Response headers:")
        for key, value in response.headers.items():
            print(f"  {key}: {value}")
        print(f"Response body: {response.body}")

        body_lower = response.body.lower()
        hints: List[str] = []
        if "dateatclient" in body_lower or "date" in body_lower:
            hints.append("Response mentions date/dateAtClient — retrying with dateAtClient header")
        if "signature" in body_lower:
            hints.append("Response mentions signature — retrying with signature header")
        if "oauth" in body_lower or "token" in body_lower:
            hints.append("Response may indicate expired/invalid OAuth token — re-authenticate if retries fail")
        if not hints:
            hints.append("No explicit header hints found; applying dateAtClient + signature retries per Woohoo/Qwikcilver conventions")

        for hint in hints:
            logger.info("401 hint: %s", hint)

    # ------------------------------------------------------------------ Persistence helpers
    def sync_catalog_to_db(self, session: Session) -> Dict[str, int]:
        self.authenticate(session)
        categories = self.fetch_all_categories()

        stats = {
            "categories_added": 0,
            "categories_updated": 0,
            "subcategories_added": 0,
            "subcategories_updated": 0,
        }

        for category_data in categories:
            category_id = self._extract_id(category_data, ("id", "categoryId", "category_id"))
            category_name = self._extract_name(category_data)
            if not category_id:
                logger.warning("Skipping category without id: %s", category_data)
                continue

            created, updated = self._upsert_category(session, category_id, category_name, category_data)
            stats["categories_added"] += int(created)
            stats["categories_updated"] += int(updated)

            local_category = session.query(Category).filter_by(woohoo_category_id=category_id).one()

            nested = self._extract_nested_subcategories(category_data)
            api_subcategories = self.fetch_subcategories(category_id)
            all_subcategories = self._merge_subcategory_sources(nested, api_subcategories)

            sub_stats = self._sync_subcategories_recursive(
                session=session,
                local_category_id=local_category.id,
                woohoo_category_id=category_id,
                subcategories=all_subcategories,
                parent_subcategory_id=None,
            )
            stats["subcategories_added"] += sub_stats["added"]
            stats["subcategories_updated"] += sub_stats["updated"]

        session.flush()
        return stats

    def _sync_subcategories_recursive(
        self,
        *,
        session: Session,
        local_category_id: int,
        woohoo_category_id: str,
        subcategories: List[Dict[str, Any]],
        parent_subcategory_id: Optional[int],
    ) -> Dict[str, int]:
        stats = {"added": 0, "updated": 0}

        for sub_data in subcategories:
            sub_id = self._extract_id(
                sub_data,
                ("id", "subcategoryId", "subcategory_id", "categoryId", "category_id"),
            )
            sub_name = self._extract_name(sub_data)
            if not sub_id:
                logger.warning("Skipping subcategory without id: %s", sub_data)
                continue

            created, updated, local_sub = self._upsert_subcategory(
                session=session,
                woohoo_subcategory_id=sub_id,
                local_category_id=local_category_id,
                parent_subcategory_id=parent_subcategory_id,
                name=sub_name,
                raw=sub_data,
            )
            stats["added"] += int(created)
            stats["updated"] += int(updated)

            children = self._extract_nested_subcategories(sub_data)
            if children:
                child_stats = self._sync_subcategories_recursive(
                    session=session,
                    local_category_id=local_category_id,
                    woohoo_category_id=woohoo_category_id,
                    subcategories=children,
                    parent_subcategory_id=local_sub.id,
                )
                stats["added"] += child_stats["added"]
                stats["updated"] += child_stats["updated"]
                continue

            fetched_children = self.fetch_subcategories(sub_id)
            if fetched_children:
                child_stats = self._sync_subcategories_recursive(
                    session=session,
                    local_category_id=local_category_id,
                    woohoo_category_id=woohoo_category_id,
                    subcategories=fetched_children,
                    parent_subcategory_id=local_sub.id,
                )
                stats["added"] += child_stats["added"]
                stats["updated"] += child_stats["updated"]

        return stats

    def _upsert_category(
        self,
        session: Session,
        woohoo_category_id: str,
        name: str,
        raw: Dict[str, Any],
    ) -> Tuple[bool, bool]:
        existing = session.query(Category).filter_by(woohoo_category_id=woohoo_category_id).one_or_none()
        if existing is None:
            session.add(
                Category(
                    woohoo_category_id=woohoo_category_id,
                    name=name,
                    raw_response=raw,
                )
            )
            session.flush()
            return True, False

        updated = existing.name != name or existing.raw_response != raw
        if updated:
            existing.name = name
            existing.raw_response = raw
            session.flush()
        return False, updated

    def _upsert_subcategory(
        self,
        *,
        session: Session,
        woohoo_subcategory_id: str,
        local_category_id: int,
        parent_subcategory_id: Optional[int],
        name: str,
        raw: Dict[str, Any],
    ) -> Tuple[bool, bool, Subcategory]:
        existing = (
            session.query(Subcategory)
            .filter_by(woohoo_subcategory_id=woohoo_subcategory_id)
            .one_or_none()
        )
        if existing is None:
            local_sub = Subcategory(
                woohoo_subcategory_id=woohoo_subcategory_id,
                category_id=local_category_id,
                parent_subcategory_id=parent_subcategory_id,
                name=name,
                raw_response=raw,
            )
            session.add(local_sub)
            session.flush()
            return True, False, local_sub

        updated = (
            existing.name != name
            or existing.category_id != local_category_id
            or existing.parent_subcategory_id != parent_subcategory_id
            or existing.raw_response != raw
        )
        if updated:
            existing.name = name
            existing.category_id = local_category_id
            existing.parent_subcategory_id = parent_subcategory_id
            existing.raw_response = raw
            session.flush()
        return False, updated, existing

    def _load_token_from_db(self, session: Session) -> Optional[TokenPair]:
        token_row = (
            session.query(OAuthToken)
            .filter(OAuthToken.is_active.is_(True))
            .order_by(OAuthToken.id.desc())
            .first()
        )
        if not token_row:
            return None
        return TokenPair(
            oauth_token=token_row.access_token,
            oauth_token_secret=token_row.access_token_secret,
        )

    def _save_token_to_db(self, session: Session, token: TokenPair) -> None:
        session.query(OAuthToken).filter(OAuthToken.is_active.is_(True)).update(
            {"is_active": False},
            synchronize_session=False,
        )
        session.add(
            OAuthToken(
                access_token=token.oauth_token,
                access_token_secret=token.oauth_token_secret,
                is_active=True,
            )
        )
        session.flush()

    # ------------------------------------------------------------------ HTTP layer
    @retry(
        retry=retry_if_exception_type((httpx.TimeoutException, httpx.TransportError)),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=8),
        reraise=True,
    )
    def _consumer_signed_request(
        self,
        method: str,
        url: str,
        *,
        step_name: str = "consumer_signed",
    ) -> HTTPDebugResponse:
        oauth = OAuth1Client(
            client_key=self.settings.woohoo_consumer_key,
            client_secret=self.settings.woohoo_consumer_secret,
            signature_method="HMAC-SHA1",
            nonce=secrets.token_hex(16),
            timestamp=str(int(time.time())),
            callback_uri="oob",
        )
        signed_url, headers, _ = oauth.sign(
            uri=url,
            http_method=method.upper(),
            body=None,
            headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"},
        )

        try:
            with httpx.Client(timeout=self.timeout) as client:
                response = client.request(method, signed_url, headers=headers)
            self._save_response(f"http_{step_name}", self._response_payload(response))
            return HTTPDebugResponse(
                status_code=response.status_code,
                headers=dict(response.headers),
                body=response.text,
            )
        except httpx.HTTPError as exc:
            logger.error("HTTP transport error during %s: %s", step_name, exc)
            raise

    @retry(
        retry=retry_if_exception_type((httpx.TimeoutException, httpx.TransportError)),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=8),
        reraise=True,
    )
    def _unsigned_request(
        self,
        method: str,
        url: str,
        *,
        data: Optional[Dict[str, str]] = None,
        step_name: str = "unsigned",
    ) -> HTTPDebugResponse:
        try:
            with httpx.Client(timeout=self.timeout) as client:
                req_headers = {"User-Agent": "Mozilla/5.0"}
                if data:
                    req_headers["Content-Type"] = "application/x-www-form-urlencoded"
                response = client.request(
                    method,
                    url,
                    data=data,
                    headers=req_headers,
                )
            self._save_response(f"http_{step_name}", self._response_payload(response))
            return HTTPDebugResponse(
                status_code=response.status_code,
                headers=dict(response.headers),
                body=response.text,
            )
        except httpx.HTTPError as exc:
            logger.error("HTTP transport error during %s: %s", step_name, exc)
            raise

    @retry(
        retry=retry_if_exception_type((httpx.TimeoutException, httpx.TransportError)),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=8),
        reraise=True,
    )
    def _signed_request(
        self,
        method: str,
        url: str,
        *,
        token: TokenPair,
        verifier: Optional[str] = None,
        extra_params: Optional[Dict[str, str]] = None,
        extra_headers: Optional[Dict[str, str]] = None,
        json_body: Optional[Dict[str, Any]] = None,
        step_name: str = "signed",
    ) -> HTTPDebugResponse:
        signed_url, headers = self._sign_url(method, url, token, verifier, extra_params)
        headers.update(extra_headers or {})
        curl_cmd = f"curl -X {method} '{signed_url}'"
        for k, v in headers.items():
            curl_cmd += f" -H '{k}: {v}'"
        if json_body:
            import json
            curl_cmd += f" -d '{json.dumps(json_body)}'"
        print("--- CURL COMMAND ---")
        print(curl_cmd)
        print("--------------------")

        try:
            with httpx.Client(timeout=self.timeout) as client:
                response = client.request(method, signed_url, headers=headers, json=json_body)
            self._save_response(f"http_{step_name}", self._response_payload(response))
            return HTTPDebugResponse(
                status_code=response.status_code,
                headers=dict(response.headers),
                body=response.text,
            )
        except httpx.HTTPError as exc:
            logger.error("HTTP transport error during %s: %s", step_name, exc)
            raise

    def _sign_url(
        self,
        method: str,
        url: str,
        token: TokenPair,
        verifier: Optional[str] = None,
        extra_params: Optional[Dict[str, str]] = None,
    ) -> Tuple[str, Dict[str, str]]:
        if extra_params:
            parsed = urlparse(url)
            query = dict(parse_qsl(parsed.query))
            query.update(extra_params)
            url = urlunparse(parsed._replace(query=urlencode(query)))

        oauth = OAuth1Client(
            client_key=self.settings.woohoo_consumer_key,
            client_secret=self.settings.woohoo_consumer_secret,
            resource_owner_key=token.oauth_token,
            resource_owner_secret=token.oauth_token_secret,
            signature_method="HMAC-SHA1",
            nonce=secrets.token_hex(16),
            timestamp=str(int(time.time())),
            verifier=verifier,
        )
        signed_url, headers, _ = oauth.sign(
            uri=url,
            http_method=method.upper(),
            body=None,
            headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "Mozilla/5.0"},
        )
        return signed_url, headers

    # ------------------------------------------------------------------ Utilities
    def _require_access_token(self) -> TokenPair:
        if self._access_token is None:
            raise WoohooAuthError("Access token not available. Call authenticate() first.")
        return self._access_token

    def _save_response(self, name: str, payload: Any) -> None:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        path = self.responses_dir / f"{timestamp}_{name}.json"
        with path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, default=str)
        logger.debug("Saved raw response to %s", path)

    @staticmethod
    def _response_payload(response: httpx.Response) -> Dict[str, Any]:
        return {
            "status_code": response.status_code,
            "headers": dict(response.headers),
            "body": response.text,
        }

    @staticmethod
    def _parse_json(body: str) -> Any:
        if not body:
            return {}
        return json.loads(body)

    @staticmethod
    def _extract_verifier(body: str) -> Optional[str]:
        try:
            payload = json.loads(body)
            if isinstance(payload, dict):
                return payload.get("verifier") or payload.get("oauth_verifier")
        except json.JSONDecodeError:
            parsed = dict(parse_qsl(body))
            return parsed.get("oauth_verifier") or parsed.get("verifier")
        return None

    @staticmethod
    def _extract_id(data: Dict[str, Any], keys: Tuple[str, ...]) -> Optional[str]:
        for key in keys:
            value = data.get(key)
            if value is not None:
                return str(value)
        return None

    @staticmethod
    def _extract_name(data: Dict[str, Any]) -> str:
        for key in ("name", "categoryName", "category_name", "title", "label"):
            value = data.get(key)
            if value:
                return str(value)
        return "Unknown"

    @staticmethod
    def _normalize_category_list(payload: Any) -> List[Dict[str, Any]]:
        if isinstance(payload, list):
            return [item for item in payload if isinstance(item, dict)]
        if isinstance(payload, dict):
            for key in ("categories", "items", "data", "result"):
                value = payload.get(key)
                if isinstance(value, list):
                    return [item for item in value if isinstance(item, dict)]
            if any(k in payload for k in ("id", "categoryId", "category_id")):
                return [payload]
        return []

    @staticmethod
    def _normalize_subcategory_list(payload: Any) -> List[Dict[str, Any]]:
        if isinstance(payload, list):
            return [item for item in payload if isinstance(item, dict)]
        if isinstance(payload, dict):
            for key in ("subcategories", "subCategories", "items", "data", "children"):
                value = payload.get(key)
                if isinstance(value, list):
                    return [item for item in value if isinstance(item, dict)]
        return []

    @staticmethod
    def _extract_nested_subcategories(data: Dict[str, Any]) -> List[Dict[str, Any]]:
        for key in ("subcategories", "subCategories", "children", "childCategories"):
            value = data.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
        return []

    @staticmethod
    def _merge_subcategory_sources(
        nested: List[Dict[str, Any]],
        fetched: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        merged: Dict[str, Dict[str, Any]] = {}
        for item in nested + fetched:
            item_id = WoohooClient._extract_id(
                item,
                ("id", "subcategoryId", "subcategory_id", "categoryId", "category_id"),
            )
            if item_id:
                merged[item_id] = item
        return list(merged.values())

    @staticmethod
    def _build_date_at_client() -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def _build_signature_header(self, url: str, method: str, date_at_client: str) -> str:
        base_string = f"{method.upper()}&{url}&dateAtClient={date_at_client}"
        import hmac
        import hashlib
        import base64

        digest = hmac.new(
            self.settings.woohoo_consumer_secret.encode("utf-8"),
            base_string.encode("utf-8"),
            hashlib.sha256,
        ).digest()
        return base64.b64encode(digest).decode("utf-8")
