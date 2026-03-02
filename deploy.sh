#!/bin/bash

# ODIC Environmental - Quick Deployment Script
# Usage: ./deploy.sh [option]
#
# Options:
#   local       - Run with Docker Compose locally
#   railway     - Deploy to Railway.app
#   heroku      - Deploy to Heroku
#   help        - Show this message

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

print_header() {
    echo ""
    echo "╔════════════════════════════════════════════════════════════╗"
    echo "║     ODIC Environmental ESA Report System - Deployment      ║"
    echo "╚════════════════════════════════════════════════════════════╝"
    echo ""
}

print_success() {
    echo "✅ $1"
}

print_error() {
    echo "❌ $1"
    exit 1
}

print_info() {
    echo "ℹ️  $1"
}

deploy_local() {
    print_header
    print_info "Starting local deployment with Docker Compose..."
    echo ""
    
    # Check Docker
    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed. Please install Docker Desktop first."
    fi
    
    if ! command -v docker-compose &> /dev/null; then
        print_error "Docker Compose is not installed. Please install Docker Desktop first."
    fi
    
    print_success "Docker found"
    
    # Check Ollama
    if ! curl -s http://localhost:11434 > /dev/null 2>&1; then
        print_error "Ollama is not running. Start Ollama first: brew services start ollama"
    fi
    
    print_success "Ollama is running"
    
    # Build and start
    echo ""
    print_info "Building Docker images and starting services..."
    docker-compose up --build
}

deploy_railway() {
    print_header
    print_info "Deploying to Railway.app..."
    echo ""
    
    # Check if Railway CLI is installed
    if ! command -v railway &> /dev/null; then
        print_info "Installing Railway CLI..."
        npm install -g @railway/cli
    fi
    
    # Check GitHub
    if ! git remote get-url origin > /dev/null 2>&1; then
        print_error "Not a Git repository. Run 'git init' first."
    fi
    
    print_success "Git repository found"
    
    # Push to GitHub
    echo ""
    print_info "Pushing to GitHub..."
    git push origin main
    
    # Railway login
    echo ""
    print_info "Logging into Railway..."
    railway login
    
    # Create project
    echo ""
    print_info "Creating Railway project..."
    railway init
    
    # Deploy
    echo ""
    print_info "Deploying to Railway..."
    railway up
    
    # Show status
    echo ""
    print_success "Deployment complete!"
    echo ""
    echo "Your app is now live! Get the URL:"
    railway open
}

deploy_heroku() {
    print_header
    print_info "Deploying to Heroku..."
    echo ""
    
    # Check Heroku CLI
    if ! command -v heroku &> /dev/null; then
        print_error "Heroku CLI not found. Install from: https://devcenter.heroku.com/articles/heroku-cli"
    fi
    
    print_success "Heroku CLI found"
    
    # Login
    echo ""
    print_info "Logging into Heroku..."
    heroku login
    
    # Create app
    echo ""
    print_info "Creating Heroku app..."
    APP_NAME="odic-environmental-$(date +%s)"
    heroku create $APP_NAME
    
    # Set buildpacks
    print_info "Setting buildpacks..."
    heroku buildpacks:add heroku/python -a $APP_NAME
    heroku buildpacks:add heroku/nodejs -a $APP_NAME
    
    # Deploy
    echo ""
    print_info "Deploying..."
    git push heroku main
    
    # Open
    echo ""
    print_success "Deployment complete!"
    heroku open -a $APP_NAME
}

show_help() {
    cat << EOF
╔════════════════════════════════════════════════════════════╗
║     ODIC Environmental - Deployment Script                 ║
╚════════════════════════════════════════════════════════════╝

USAGE:
  ./deploy.sh [option]

OPTIONS:
  local       Deploy locally with Docker Compose
              - Requires: Docker Desktop, Ollama
              - Access: http://localhost:5173
              
  railway     Deploy to Railway.app (recommended)
              - Requires: GitHub account, Railway account
              - Free tier available ($5/month credit)
              - Easy auto-deploy from Git
              
  heroku      Deploy to Heroku
              - Requires: Heroku account
              - Deprecated but still works
              
  help        Show this message

EXAMPLES:
  ./deploy.sh local
  ./deploy.sh railway
  ./deploy.sh heroku

QUICK START:
  1. Local testing:
     ./deploy.sh local
     
  2. Production deployment:
     ./deploy.sh railway

REQUIREMENTS:
  - Git (for any deployment)
  - Docker (for local)
  - Ollama (for local)
  - GitHub account (for Railway)
  - Railway account (for Railway deployment)
  
DOCUMENTATION:
  - DEPLOYMENT.md       - Full deployment guide
  - RAILWAY_QUICKSTART.md - Railway step-by-step
  - README.md           - Project overview
  
SUPPORT:
  - Railway Docs: https://docs.railway.app
  - Docker Docs: https://docs.docker.com
  - GitHub Issues: https://github.com/bpickett2019/ODIC-Environmental/issues

EOF
}

# Main
if [ $# -eq 0 ]; then
    show_help
    exit 0
fi

case "$1" in
    local)
        deploy_local
        ;;
    railway)
        deploy_railway
        ;;
    heroku)
        deploy_heroku
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        print_error "Unknown option: $1. Use './deploy.sh help' for options."
        ;;
esac
