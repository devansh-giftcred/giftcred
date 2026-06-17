from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    woohoo_consumer_key: str = Field(alias="WOOHOO_CONSUMER_KEY")
    woohoo_consumer_secret: str = Field(alias="WOOHOO_CONSUMER_SECRET")
    woohoo_username: str = Field(alias="WOOHOO_USERNAME")
    woohoo_password: str = Field(alias="WOOHOO_PASSWORD")
    woohoo_base_url: str = Field(
        default="https://sandbox.woohoo.in",
        alias="WOOHOO_BASE_URL",
    )
    woohoo_request_timeout: int = Field(default=30, alias="WOOHOO_REQUEST_TIMEOUT")
    woohoo_max_retries: int = Field(default=3, alias="WOOHOO_MAX_RETRIES")

    postgres_host: str = Field(default="localhost", alias="POSTGRES_HOST")
    postgres_port: int = Field(default=5432, alias="POSTGRES_PORT")
    postgres_db: str = Field(default="woohoo_catalog", alias="POSTGRES_DB")
    postgres_user: str = Field(default="postgres", alias="POSTGRES_USER")
    postgres_password: str = Field(default="postgres", alias="POSTGRES_PASSWORD")

    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    @property
    def database_url(self) -> str:
        return f"postgresql+psycopg2://{self.postgres_user}:{self.postgres_password}@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"

    @property
    def base_url(self) -> str:
        return self.woohoo_base_url.rstrip("/")


@lru_cache
def get_settings() -> Settings:
    return Settings()
