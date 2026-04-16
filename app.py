from flask import Flask, render_template, request, session, redirect, url_for
from functools import wraps
import os

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'dev-secret-change-in-prod')

SUPABASE_URL = os.environ.get('SUPABASE_URL', '')
SUPABASE_KEY = os.environ.get('SUPABASE_ANON_KEY', '')

AUTH_REQUIRED = bool(SUPABASE_URL and SUPABASE_KEY)

supabase = None
if AUTH_REQUIRED:
    try:
        from supabase import create_client
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    except Exception as e:
        print(f"[dvpages] Supabase init error: {e}")

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if AUTH_REQUIRED and 'user_id' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated

@app.route('/login', methods=['GET', 'POST'])
def login():
    if not AUTH_REQUIRED:
        return redirect(url_for('index'))
    if 'user_id' in session:
        return redirect(url_for('index'))
    error = None
    if request.method == 'POST':
        if supabase is None:
            error = 'Erro interno — tente novamente em instantes'
        else:
            email = request.form.get('email', '').strip()
            password = request.form.get('password', '')
            try:
                res = supabase.auth.sign_in_with_password({'email': email, 'password': password})
                session['user_id'] = res.user.id
                session['user_email'] = res.user.email
                return redirect(url_for('index'))
            except Exception:
                error = 'Email ou senha inválidos'
    return render_template('login.html', error=error)

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))

@app.route('/')
@login_required
def index():
    user_email = session.get('user_email', '')
    return render_template('index.html', user_email=user_email)

@app.route('/_debug')
def debug():
    import json
    return app.response_class(
        json.dumps({
            'auth_required': AUTH_REQUIRED,
            'supabase_url': bool(SUPABASE_URL),
            'supabase_key': bool(SUPABASE_KEY),
            'supabase_client': supabase is not None,
        }),
        mimetype='application/json'
    )

if __name__ == '__main__':
    print("DvPages rodando em http://localhost:5051")
    app.run(debug=True, port=5051)
