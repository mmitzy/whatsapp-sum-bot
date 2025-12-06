# config.py
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    # This field will automatically look for an environment variable named VERIFY_TOKEN
    # (or VERIFY_TOKEN inside your .env file)
    VERIFY_TOKEN: str

    # Pydantic configuration to load the .env file
    model_config = SettingsConfigDict(
        env_file='.env',
        env_file_encoding='utf-8',
        case_sensitive=True 
    )