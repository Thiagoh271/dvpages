@echo off
echo Iniciando PageLens...
pip install -r requirements.txt -q
start http://localhost:5051
python app.py
pause
