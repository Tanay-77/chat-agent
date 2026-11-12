import React from 'react';
import { marked } from 'marked';
import { HistoricalMessage } from '../types.js';

interface InspectorModalProps {
  date: string | null;
  messages: HistoricalMessage[];
  onClose: () => void;
}

export const InspectorModal: React.FC<InspectorModalProps> = ({ date, messages, onClose }) => {
  if (!date) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3>Timeline Inspector</h3>
            <p className="modal-subtitle">Messages recorded on {date}</p>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          {messages.map((msg) => (
            <div key={msg.id} className={`modal-msg-bubble ${msg.role}`}>
              <div className="modal-msg-meta">
                <span className="meta-role">{msg.role.toUpperCase()}</span>
                <span className="meta-time">
                  {msg.created_at.slice(0, 16).replace('T', ' ')} UTC
                </span>
                <span className="meta-session">session: {msg.session_id}</span>
              </div>
              <div
                className="modal-msg-content markdown-body"
                dangerouslySetInnerHTML={{
                  __html: marked.parse(msg.content, { breaks: true, gfm: true }) as string
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

