from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    create_engine,
)
from sqlalchemy.orm import DeclarativeBase, Session, relationship, sessionmaker

from config import settings
from models import DocumentStatus, ReportStatus, SectionCategory


class Base(DeclarativeBase):
    pass


class Report(Base):
    __tablename__ = "reports"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(500), nullable=False)
    address = Column(String(500))
    project_number = Column(String(100))
    has_reliance_letter = Column(Boolean, default=True)
    status = Column(String(20), default=ReportStatus.TODO.value)
    assembled_filename = Column(String(500))
    assembled_size = Column(Integer)
    compressed_size = Column(Integer)
    manifest_json = Column(Text)
    pipeline_start_time = Column(DateTime)
    pipeline_end_time = Column(DateTime)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    documents = relationship("Document", back_populates="report", cascade="all, delete-orphan")

    @property
    def document_count(self) -> int:
        return len(self.documents) if self.documents else 0


class Document(Base):
    __tablename__ = "documents"

    id = Column(Integer, primary_key=True, autoincrement=True)
    report_id = Column(Integer, ForeignKey("reports.id", ondelete="CASCADE"), nullable=False)
    original_filename = Column(String(500), nullable=False)
    original_path = Column(String(1000))
    stored_filename = Column(String(500), nullable=False)
    pdf_filename = Column(String(500))
    file_size = Column(Integer, default=0)
    page_count = Column(Integer)
    category = Column(String(30), default=SectionCategory.UNCLASSIFIED.value)
    subcategory = Column(String(50))
    confidence = Column(Float)
    reasoning = Column(Text)
    sort_order = Column(Integer, default=0)
    status = Column(String(20), default=DocumentStatus.UPLOADED.value)
    is_included = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    report = relationship("Report", back_populates="documents")


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True, autoincrement=True)
    report_id = Column(Integer, ForeignKey("reports.id", ondelete="CASCADE"), nullable=False)
    role = Column(String(20), nullable=False)  # "user" or "assistant"
    content = Column(Text, nullable=False)
    actions_json = Column(Text)  # JSON string of actions taken
    created_at = Column(DateTime, default=datetime.utcnow)

    report = relationship("Report")


class ActionSnapshot(Base):
    __tablename__ = "action_snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    report_id = Column(Integer, ForeignKey("reports.id", ondelete="CASCADE"), nullable=False)
    chat_message_id = Column(Integer, ForeignKey("chat_messages.id", ondelete="CASCADE"))
    snapshot_json = Column(Text, nullable=False)  # JSON of affected docs before change
    created_at = Column(DateTime, default=datetime.utcnow)

    report = relationship("Report")
    chat_message = relationship("ChatMessage")


# Database setup — WAL mode + busy timeout for concurrent background task access
engine = create_engine(
    settings.DATABASE_URL,
    connect_args={"check_same_thread": False, "timeout": 30},
    echo=False,
    pool_pre_ping=True,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


from sqlalchemy import event as _sa_event

@_sa_event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=30000")
    cursor.close()


def init_db():
    Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
