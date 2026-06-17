from datetime import datetime
from typing import Any, Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func, JSON
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class OAuthToken(Base, TimestampMixin):
    __tablename__ = "oauth_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    access_token: Mapped[str] = mapped_column(String(512), nullable=False)
    access_token_secret: Mapped[str] = mapped_column(String(512), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class Category(Base, TimestampMixin):
    __tablename__ = "categories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    woohoo_category_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(512), nullable=False)
    raw_response: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)

    subcategories: Mapped[list["Subcategory"]] = relationship(
        "Subcategory",
        back_populates="category",
        cascade="all, delete-orphan",
    )


class Subcategory(Base, TimestampMixin):
    __tablename__ = "subcategories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    woohoo_subcategory_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    category_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("categories.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    parent_subcategory_id: Mapped[Optional[int]] = mapped_column(
        Integer,
        ForeignKey("subcategories.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(512), nullable=False)
    raw_response: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)

    category: Mapped["Category"] = relationship("Category", back_populates="subcategories")
    parent: Mapped[Optional["Subcategory"]] = relationship(
        "Subcategory",
        remote_side="Subcategory.id",
        back_populates="children",
    )
    children: Mapped[list["Subcategory"]] = relationship(
        "Subcategory",
        back_populates="parent",
        cascade="all, delete-orphan",
    )

class Order(Base, TimestampMixin):
    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    refno: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    items: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True) # Will store list of items
    mobile_number: Mapped[str] = mapped_column(String(32), nullable=False)
    email: Mapped[str] = mapped_column(String(255), nullable=True)

